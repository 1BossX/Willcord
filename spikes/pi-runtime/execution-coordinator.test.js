import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { coordinatorFixture } from './coordinator-test-support.js';
import { piUsage } from './execution-coordinator.js';

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-coordinator-'));
  const f = await coordinatorFixture(root, options);
  t.after(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  f.coordinator.createJob({ jobId: 'job', maxTokens: 100000, maxSteps: 10, prompt: 'original request' });
  return { root, ...f };
}
function core(messages) {
  const c = createFauxCore({ provider: 'coordinator', api: 'coordinator', models: [{ id: 'test' }] }); c.setResponses(messages); return c;
}
function response(content, usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 1 }) {
  const m = fauxAssistantMessage(content, { stopReason: Array.isArray(content) ? 'toolUse' : 'stop' });
  Object.assign(m.usage, usage); return m;
}

test('actual Pi batch atomically accounts cached usage once, binds and executes serially, then completes', async (t) => {
  const effects = [];
  const f = await fixture(t, { execute: async (request) => { effects.push(request.callId); return { content: [{ type: 'text', text: request.callId }] }; } });
  const c = core([response([fauxToolCall('read', {}, { id: 'original-1' }), fauxToolCall('write', {}, { id: 'original-2' })]), response('finished')]);
  assert.equal((await f.coordinator.runStep('job', c.streamSimple)).lifecycle, 'ready');
  assert.deepEqual(effects, ['original-1', 'original-2']);
  assert.equal(c.state.callCount, 1);
  assert.equal(f.coordinator.readJob('job').steps, 1);
  const persisted = f.store.readHistory('job').find((entry) => entry.turn).turn.assistantMessage;
  const accounted = piUsage(persisted);
  assert.equal(f.coordinator.readJob('job').inputTokens, accounted.inputTokens);
  assert.equal(f.coordinator.readJob('job').outputTokens, accounted.outputTokens);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_worker_bindings').get().n, 2);
  assert.equal((await f.coordinator.runStep('job', c.streamSimple)).lifecycle, 'completed');
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/);
  assert.equal(c.state.callCount, 2);
});

test('binding failure rolls back usage and entire intent transaction', async (t) => {
  const f = await fixture(t);
  f.coordinator.reconciler.bind = () => { throw new Error('injected binding persistence failure'); };
  const c = core([response([fauxToolCall('write', {}, { id: 'rollback' })])]);
  await f.coordinator.runStep('job', c.streamSimple);
  assert.equal(f.coordinator.readJob('job').lifecycle, 'needs_attention');
  assert.equal(f.coordinator.readJob('job').steps, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_turns').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_worker_bindings').get().n, 0);
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
});

test('budget crossing pairs not-executed results and prevents all worker effects and next request', async (t) => {
  let effects = 0;
  const f = await fixture(t, { execute: async () => { effects++; return { content: [] }; } });
  f.store.db.prepare('UPDATE runtime_job_state SET max_tokens = 5').run();
  const c = core([response([fauxToolCall('write', {}, { id: 'blocked' })])]);
  assert.equal((await f.coordinator.runStep('job', c.streamSimple)).lifecycle, 'budget_exceeded');
  assert.equal(effects, 0); assert.equal(c.state.callCount, 1);
  const call = f.store.findIncompleteTurns('job'); assert.equal(call.length, 0);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 0);
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/);
});

test('step attempts are durable and root budget gates the next model request', async (t) => {
  const f = await fixture(t);
  f.store.db.prepare('UPDATE runtime_roots SET max_steps = 1').run();
  const c = core([response([fauxToolCall('read', {}, { id: 'last' })])]);
  await f.coordinator.runStep('job', c.streamSimple);
  assert.equal((await f.coordinator.runStep('job', c.streamSimple)).lifecycle, 'budget_exceeded');
  assert.equal(c.state.callCount, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_attempts').get().n, 1);
});

test('cancel fences late provider reply before usage, tools and terminal update', async (t) => {
  let effects = 0;
  const f = await fixture(t, { execute: async () => { effects++; return { content: [] }; } });
  let started; const start = new Promise((resolve) => { started = resolve; });
  let sendLate;
  const stream = () => {
    const events = createAssistantMessageEventStream();
    sendLate = () => events.push({ type: 'done', reason: 'toolUse', message: response([fauxToolCall('write', {}, { id: 'late' })]) });
    started(); return events;
  };
  const running = f.coordinator.runStep('job', stream);
  await start;
  const cancellation = f.coordinator.cancel('job');
  sendLate(); await cancellation; await running;
  assert.equal(f.coordinator.readJob('job').lifecycle, 'cancelled');
  assert.equal(f.coordinator.readJob('job').steps, 0);
  assert.equal(effects, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_turns').get().n, 0);
  await assert.rejects(f.coordinator.runStep('job', stream), /not ready/);
});

test('cache usage semantics are explicit and invalid final usage is rejected', () => {
  assert.deepEqual(piUsage(response('ok')), { inputTokens: 7, outputTokens: 3 });
  assert.throws(() => piUsage({ usage: { input: 1, output: 1 } }), /authoritative usage/);
});

for (const mode of ['model', 'intent', 'effect', 'result']) {
  test(`actual Pi/SQLite SIGKILL ${mode} window keeps budgets and original intent`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-plane-coordinator-crash-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, mode]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    let effects = 0;
    const f = await coordinatorFixture(root, { bootId: 'new-boot', execute: async (request) => {
      effects++; appendFileSync(join(root, 'effects.log'), `${request.callId}\n`);
      return { content: [{ type: 'text', text: 'recovered original result' }] };
    } });
    t.after(() => f.close());
    const before = f.coordinator.readJob('job');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_attempts').get().n, 1);
    const recovered = await f.coordinator.recover('job');
    assert.equal(recovered.lifecycle, ['model', 'effect'].includes(mode) ? 'needs_attention' : 'ready');
    if (mode === 'model') {
      assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
      assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
    }
    assert.equal(recovered.inputTokens, before.inputTokens);
    assert.equal(recovered.outputTokens, before.outputTokens);
    assert.equal(recovered.steps, before.steps);
    assert.equal(effects, mode === 'intent' ? 1 : 0);
    if (mode !== 'model') {
      const call = f.store.readAuthorizedCall('job', f.store.readHistory('job').find((entry) => entry.turn).turn.turnKey, 'original-call');
      assert.deepEqual(call.arguments, { input: 'original' });
      assert.equal(readFileSync(join(root, 'effects.log'), 'utf8'), 'original-call\n');
      if (mode === 'result') assert.equal(call.result.content[0].text, 'cached original result');
    }
    const next = core([response('finished after recovery')]);
    if (recovered.lifecycle === 'ready') {
      assert.equal((await f.coordinator.runStep('job', next.streamSimple)).lifecycle, 'completed');
      assert.equal(next.state.callCount, 1, 'committed tool turn was not regenerated');
    } else {
      await assert.rejects(f.coordinator.runStep('job', next.streamSimple), /not ready/);
      assert.equal(next.state.callCount, 0);
    }
  });
}

test('cancel running worker imports factual result but does not dispatch later batch calls', async (t) => {
  let started; const start = new Promise((resolve) => { started = resolve; });
  let release;
  let effects = 0;
  const f = await fixture(t, { execute: async () => { effects++; started(); await new Promise((resolve) => { release = resolve; }); return { content: [{ type: 'text', text: 'real effect completed' }] }; } });
  const c = core([response([fauxToolCall('write', {}, { id: 'running' }), fauxToolCall('read', {}, { id: 'never-accepted' })])]);
  const running = f.coordinator.runStep('job', c.streamSimple);
  await start;
  const cancellation = f.coordinator.cancel('job');
  release(); await cancellation; await running;
  assert.equal(f.coordinator.readJob('job').lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'cancelled');
  assert.equal(effects, 1);
  const calls = f.store.readHistory('job').find((entry) => entry.turn).turn.calls;
  assert.equal(calls[0].result.content[0].text, 'real effect completed');
  assert.equal(calls[1].result.details.notExecuted, true);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 1);
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/);
  assert.equal(c.state.callCount, 1);
});

test('shared root budget is rechecked between serial worker acceptances', async (t) => {
  let effects = 0;
  let f;
  f = await fixture(t, { execute: async () => {
    effects++;
    f.store.db.prepare('UPDATE runtime_roots SET input_tokens = max_tokens + 1').run();
    return { content: [{ type: 'text', text: 'first effect' }] };
  } });
  const c = core([response([fauxToolCall('read', {}, { id: 'first' }), fauxToolCall('write', {}, { id: 'budget-blocked' })])]);
  await f.coordinator.runStep('job', c.streamSimple);
  assert.equal(f.coordinator.readJob('job').lifecycle, 'budget_exceeded');
  assert.equal(effects, 1);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 1);
  assert.equal(f.store.findIncompleteTurns('job').length, 0);
});

test('cancel during recovered execution fences completion and excludes concurrent recovery/model work', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-recover-cancel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, 'intent']);
  assert.equal(child.signal, 'SIGKILL');
  let started; const start = new Promise((resolve) => { started = resolve; });
  let release;
  const f = await coordinatorFixture(root, { bootId: 'new-boot', execute: async () => { started(); await new Promise((resolve) => { release = resolve; }); return { content: [{ type: 'text', text: 'recovered effect completed' }] }; } });
  t.after(() => f.close());
  const recovery = f.coordinator.recover('job'); await start;
  await assert.rejects(f.coordinator.recover('job'), /active job/);
  const c = core([response('must not run')]);
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /already active/);
  const generation = f.coordinator.readJob('job').generation;
  await f.coordinator.cancel('job');
  assert.equal(f.coordinator.readJob('job').generation, generation + 1);
  release();
  assert.equal((await recovery).lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'cancelled');
  assert.equal(c.state.callCount, 0);
});

test('restart recovery preserves budget-exceeded lifecycle after safely rejecting pending intent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-recover-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, 'intent']);
  assert.equal(child.signal, 'SIGKILL');
  let effects = 0;
  const f = await coordinatorFixture(root, { bootId: 'new-boot', execute: async () => { effects++; return { content: [] }; } });
  t.after(() => f.close());
  f.store.db.prepare('UPDATE runtime_roots SET input_tokens = max_tokens + 1').run();
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'budget_exceeded');
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'budget_exceeded');
  assert.equal(effects, 0);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 0);
  assert.equal(f.store.findIncompleteTurns('job').length, 0);
  const c = core([response('must not run')]);
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/);
  assert.equal(c.state.callCount, 0);
});

test('actual Pi first valid hook persists later invalid intent but recovery never executes malformed arguments', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-invalid-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, 'invalid_intent']);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const effects = [];
  const f = await coordinatorFixture(root, { bootId: 'new-boot', execute: async (request) => { effects.push(request.callId); return { content: [] }; } });
  t.after(() => f.close());
  const committed = f.store.readHistory('job').find((entry) => entry.turn).turn;
  assert.equal(committed.calls.length, 2, 'first valid SDK hook committed whole original batch');
  assert.deepEqual(committed.calls[1].arguments, { input: { invalid: true } });
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'ready');
  assert.deepEqual(effects, ['original-call']);
  const rejected = f.store.readAuthorizedCall('job', committed.turnKey, 'invalid-later-call');
  assert.equal(rejected.status, 'completed');
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.details.notExecuted, true);
  assert.match(rejected.result.content[0].text, /Invalid original tool arguments/);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 1);
});

test('live Pi coerced arguments are rejected before original-payload worker acceptance', async (t) => {
  let effects = 0;
  const f = await fixture(t, { execute: async () => { effects++; return { content: [] }; } });
  const c = core([response([fauxToolCall('read', { input: 123 }, { id: 'coerced' })])]);
  await f.coordinator.runStep('job', c.streamSimple);
  assert.equal(effects, 0);
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 0);
  const call = f.store.readHistory('job').find((entry) => entry.turn).turn.calls[0];
  assert.deepEqual(call.arguments, { input: 123 });
  assert.equal(call.result.details.notExecuted, true);
});

test('SIGKILL after recovery opening transaction cannot erase durable unknown model attempt', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-recovery-open-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const modelCrash = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, 'model']);
  assert.equal(modelCrash.signal, 'SIGKILL', modelCrash.stderr.toString());
  const recoveryCrash = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-recovery-crash-fixture.js', import.meta.url)), root]);
  assert.equal(recoveryCrash.signal, 'SIGKILL', recoveryCrash.stderr.toString());
  const f = await coordinatorFixture(root, { bootId: 'third-boot' });
  t.after(() => f.close());
  assert.equal(f.coordinator.readJob('job').lifecycle, 'needs_attention');
  assert.equal(f.coordinator.readJob('job').generation, 2);
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_attempts').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_usage').get().n, 0);
  const c = core([response('must not run')]);
  await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/);
  assert.equal(c.state.callCount, 0);
  // Even a stale legacy lifecycle marker cannot hide the durable missing row.
  f.store.db.prepare("UPDATE coordinator_jobs SET status = 'ready'").run();
  assert.equal((await f.coordinator.runStep('job', c.streamSimple)).lifecycle, 'needs_attention');
  assert.equal(c.state.callCount, 0);
});
