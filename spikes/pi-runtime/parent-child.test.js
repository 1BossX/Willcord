import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { coordinatorFixture } from './coordinator-test-support.js';
function core(messages) { const c = createFauxCore({ provider: 'parent', api: 'parent', models: [{ id: 'test' }] }); c.setResponses(messages); return c; }
function delegate(id, input = 'child original request') { return fauxToolCall('delegate', { input }, { id }); }
async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-parent-'));
  const f = await coordinatorFixture(root, options);
  t.after(() => { f.close(); rmSync(root, { recursive: true, force: true }); });
  f.coordinator.createJob({ jobId: 'parent', role: 'main', maxTokens: 100000, maxSteps: 10, prompt: 'delegate work' });
  return { root, ...f };
}
function tools(calls) { return fauxAssistantMessage(calls, { stopReason: 'toolUse' }); }

test('actual Main Pi accepts all batch delegates once, waits without polling/slot, then resumes matched children once', async (t) => {
  const f = await fixture(t);
  const parent = core([tools([fauxToolCall('list_workers', {}, { id: 'list' }), delegate('delegate-1'), delegate('delegate-2')]), fauxAssistantMessage('parent finished')]);
  assert.equal((await f.coordinator.runStep('parent', parent.streamSimple)).lifecycle, 'waiting_children');
  assert.equal(parent.state.callCount, 1);
  const children = f.coordinator.children('parent'); assert.equal(children.length, 2);
  const sessions = f.store.db.prepare('SELECT session_id FROM coordinator_targets WHERE job_id IN (?, ?)').all(children[0].jobId, children[1].jobId).map((row) => row.session_id);
  assert.equal(new Set(sessions).size, 2); assert.ok(sessions.every((id) => id !== 'session'));
  assert.ok(children.every((child) => child.parentJobId === 'parent' && child.rootJobId === 'parent'));
  assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 0);
  await assert.rejects(f.coordinator.runStep('parent', parent.streamSimple), /not ready/);
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'waiting_children');
  const child1 = core([fauxAssistantMessage('first result')]);
  await f.coordinator.runStep(children[0].jobId, child1.streamSimple);
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'waiting_children');
  await assert.rejects(f.coordinator.runStep('parent', parent.streamSimple), /not ready/);
  const child2 = core([fauxAssistantMessage('second result')]);
  await f.coordinator.runStep(children[1].jobId, child2.streamSimple);
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'ready');
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'ready');
  assert.equal(f.store.readHistory('parent').filter((entry) => entry.entryKey.startsWith('child-result:')).length, 2);
  assert.equal((await f.coordinator.runStep('parent', parent.streamSimple)).lifecycle, 'completed');
  assert.equal(parent.state.callCount, 2);
  assert.equal(f.store.db.prepare('SELECT steps FROM runtime_roots WHERE root_job_id = ?').get('parent').steps, 4);
});

test('invalid delegate ownership/arguments never creates child and get_job cannot read another parent', async (t) => {
  const f = await fixture(t);
  f.coordinator.createJob({ jobId: 'other-parent', role: 'main', maxTokens: 100000, maxSteps: 10, prompt: 'private' });
  const other = core([tools([delegate('other-delegate')])]); await f.coordinator.runStep('other-parent', other.streamSimple);
  const foreign = f.coordinator.children('other-parent')[0].jobId;
  const parent = core([tools([delegate('valid'), fauxToolCall('delegate', { input: 'spoof', parentJobId: 'other-parent', rootJobId: 'other-parent' }, { id: 'spoof' }), fauxToolCall('get_job', { childJobId: foreign }, { id: 'foreign-get' })])]);
  await f.coordinator.runStep('parent', parent.streamSimple);
  assert.equal(f.coordinator.children('parent').length, 1);
  const calls = f.store.readHistory('parent').find((entry) => entry.turn).turn.calls;
  assert.equal(calls.find((call) => call.callId === 'spoof').result.details.notExecuted, true);
  assert.equal(calls.find((call) => call.callId === 'foreign-get').result.isError, true);
  assert.equal(parent.state.callCount, 1);
});

test('parent cancellation cascades and unknown running child keeps parent blocked', async (t) => {
  let started; const start = new Promise((resolve) => { started = resolve; }); let release;
  const f = await fixture(t, { execute: async () => { started(); await new Promise((resolve) => { release = resolve; }); return { content: [{ type: 'text', text: 'real child effect' }] }; } });
  const parent = core([tools([delegate('delegate')])]); await f.coordinator.runStep('parent', parent.streamSimple);
  const child = f.coordinator.children('parent')[0];
  const worker = core([tools([fauxToolCall('write', {}, { id: 'child-effect' })])]);
  const childRun = f.coordinator.runStep(child.jobId, worker.streamSimple); await start;
  const cancelling = f.coordinator.cancel('parent');
  assert.equal(f.coordinator.readJob('parent').cancelRequested, true);
  assert.equal(f.coordinator.readJob(child.jobId).cancelRequested, true);
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'needs_attention');
  release(); await cancelling; await childRun;
  assert.equal(f.coordinator.readJob('parent').lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover(child.jobId)).lifecycle, 'cancelled');
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'cancelled');
  await assert.rejects(f.coordinator.runStep('parent', parent.streamSimple), /not ready/);
});

test('known child failure is projected explicitly and root budget prevents parent continuation', async (t) => {
  const f = await fixture(t, { execute: async () => ({ content: [{ type: 'text', text: 'failed tool' }], isError: true }) });
  const parent = core([tools([delegate('delegate')]), fauxAssistantMessage('not requested')]); await f.coordinator.runStep('parent', parent.streamSimple);
  const child = f.coordinator.children('parent')[0];
  const worker = core([tools([fauxToolCall('write', {}, { id: 'failed-call' })])]);
  assert.equal((await f.coordinator.runStep(child.jobId, worker.streamSimple)).lifecycle, 'ready');
  assert.equal(f.coordinator.failJob(child.jobId, 'host confirmed terminal child failure').lifecycle, 'failed');
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'ready');
  const projected = f.store.readHistory('parent').find((entry) => entry.entryKey.startsWith('child-result:'));
  assert.equal(JSON.parse(projected.message.content).status, 'failed');
  f.store.db.prepare('UPDATE runtime_roots SET max_steps = steps').run();
  assert.equal((await f.coordinator.runStep('parent', parent.streamSimple)).lifecycle, 'budget_exceeded');
  assert.equal(parent.state.callCount, 1);
});

for (const mode of ['accepted', 'child_completed', 'projection_mid', 'projection']) {
  test(`actual Pi parent-child SIGKILL ${mode} retains stable IDs/wait/results/root budget`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-plane-parent-crash-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./parent-child-crash-fixture.js', import.meta.url)), root, mode]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    const f = await coordinatorFixture(root, { bootId: 'new-boot' }); t.after(() => f.close());
    const originalChildren = f.coordinator.children('parent').map((child) => child.jobId);
    assert.equal(originalChildren.length, 2);
    const before = f.store.db.prepare('SELECT * FROM runtime_roots WHERE root_job_id = ?').get('parent');
    if (mode === 'accepted') {
      assert.equal((await f.coordinator.recover('parent')).lifecycle, 'waiting_children');
      assert.equal(f.store.readHistory('parent').filter((entry) => entry.entryKey.startsWith('child-result:')).length, 0);
      for (const childId of originalChildren) {
        const c = core([fauxAssistantMessage(`original result:${childId}`)]);
        await f.coordinator.runStep(childId, c.streamSimple);
      }
    }
    assert.equal((await f.coordinator.recover('parent')).lifecycle, 'ready');
    assert.equal((await f.coordinator.recover('parent')).lifecycle, 'ready');
    assert.deepEqual(f.coordinator.children('parent').map((child) => child.jobId), originalChildren);
    assert.equal(f.store.readHistory('parent').filter((entry) => entry.entryKey.startsWith('child-result:')).length, 2);
    const now = f.store.db.prepare('SELECT * FROM runtime_roots WHERE root_job_id = ?').get('parent');
    assert.ok(now.input_tokens >= before.input_tokens && now.output_tokens >= before.output_tokens);
    assert.equal(now.steps, 3);
    const parent = core([fauxAssistantMessage('parent done')]);
    assert.equal((await f.coordinator.runStep('parent', parent.streamSimple)).lifecycle, 'completed');
    assert.equal(parent.state.callCount, 1);
    assert.equal(f.ledger.db.prepare('SELECT COUNT(*) AS n FROM worker_calls').get().n, 0);
  });
}

test('child target/session is acceptance-time snapshot and scanners cannot clear unrelated blocked state', async (t) => {
  const f = await fixture(t);
  const parent = core([tools([delegate('delegate')])]); await f.coordinator.runStep('parent', parent.streamSimple);
  const child = f.coordinator.children('parent')[0];
  f.coordinator.trustedTarget = { ...f.coordinator.trustedTarget, workspaceVersion: 'changed-config' };
  f.coordinator.sessionId = 'changed-session';
  const worker = core([tools([fauxToolCall('read', {}, { id: 'bound-child-call' })]), fauxAssistantMessage('child done')]);
  await f.coordinator.runStep(child.jobId, worker.streamSimple);
  const binding = JSON.parse(f.store.db.prepare('SELECT request_json FROM host_worker_bindings WHERE job_id = ?').get(child.jobId).request_json);
  assert.equal(binding.workspaceVersion, 'v1'); assert.equal(binding.sessionId, `session:${child.jobId}`);
  assert.notEqual(binding.sessionId, 'session');
  await f.coordinator.runStep(child.jobId, worker.streamSimple);
  f.store.db.prepare("UPDATE coordinator_jobs SET status = 'needs_attention', reason = 'unrelated generation ambiguity' WHERE job_id = 'parent'").run();
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'needs_attention');
  f.store.db.prepare("UPDATE coordinator_jobs SET status = 'budget_exceeded' WHERE job_id = 'parent'").run();
  assert.equal(f.coordinator.scanChildren('parent').lifecycle, 'budget_exceeded');
});

test('lifecycle schema upgrade preserves an old in-flight worker checkpoint and immutable binding', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./coordinator-crash-fixture.js', import.meta.url)), root, 'intent']);
  assert.equal(child.signal, 'SIGKILL');
  const f = await coordinatorFixture(root, { bootId: 'upgraded-boot' });
  const snapshot = f.coordinator.readJob('job');
  f.store.db.exec(`DROP TABLE coordinator_roles; DROP TABLE coordinator_targets;
    ALTER TABLE coordinator_jobs RENAME TO newer_jobs;
    CREATE TABLE coordinator_jobs (job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id), status TEXT NOT NULL CHECK(status IN ('ready','generating','tools','completed','cancelled','needs_attention','budget_exceeded')), cancel_requested INTEGER NOT NULL DEFAULT 0, reason TEXT);
    INSERT INTO coordinator_jobs SELECT * FROM newer_jobs; DROP TABLE newer_jobs;`);
  f.close();
  const upgraded = await coordinatorFixture(root, { bootId: 'final-boot' }); t.after(() => upgraded.close());
  assert.equal(upgraded.coordinator.readJob('job').lifecycle, snapshot.lifecycle);
  assert.equal(upgraded.coordinator.readJob('job').inputTokens, snapshot.inputTokens);
  assert.equal((await upgraded.coordinator.recover('job')).lifecycle, 'ready');
  const c = core([tools([fauxToolCall('read', {}, { id: 'upgrade-next' })])]);
  await upgraded.coordinator.runStep('job', c.streamSimple);
  assert.equal(upgraded.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_targets WHERE job_id = ?').get('job').n, 1);
});

test('Main local tools preserve submitted serial order and immutable child timeout', async (t) => {
  const f = await fixture(t);
  const { createHash } = await import('node:crypto');
  const childId = `child:${createHash('sha256').update(JSON.stringify(['parent', 'delegate'])).digest('hex')}`;
  const parent = core([tools([fauxToolCall('get_job', { childJobId: childId }, { id: 'before' }), delegate('delegate'), fauxToolCall('get_job', { childJobId: childId }, { id: 'after' })])]);
  await f.coordinator.runStep('parent', parent.streamSimple);
  const calls = f.store.readHistory('parent').find((entry) => entry.turn).turn.calls;
  assert.equal(calls[0].result.isError, true);
  assert.equal(calls[2].result.details.job.jobId, childId);
  f.coordinator.timeoutMs = 99999;
  const worker = core([tools([fauxToolCall('read', {}, { id: 'timeout-child' })])]);
  await f.coordinator.runStep(childId, worker.streamSimple);
  const binding = JSON.parse(f.store.db.prepare('SELECT request_json FROM host_worker_bindings WHERE job_id = ?').get(childId).request_json);
  assert.equal(binding.timeoutMs, 1000);
});

test('duplicate delegate ID in a new turn conflicts without creating another child', async (t) => {
  const f = await fixture(t);
  const parent = core([tools([delegate('same-id')]), tools([delegate('same-id', 'different prompt')])]);
  await f.coordinator.runStep('parent', parent.streamSimple);
  const childId = f.coordinator.children('parent')[0].jobId;
  const child = core([fauxAssistantMessage('done')]); await f.coordinator.runStep(childId, child.streamSimple);
  f.coordinator.scanChildren('parent');
  await f.coordinator.runStep('parent', parent.streamSimple);
  assert.equal(f.coordinator.readJob('parent').lifecycle, 'needs_attention');
  assert.equal(f.coordinator.children('parent').length, 1);
  assert.equal((await f.coordinator.recover('parent')).lifecycle, 'needs_attention');
});

test('all-invalid Main delegate response still commits usage, original intent and explicit rejection', async (t) => {
  const f = await fixture(t);
  const parent = core([tools([fauxToolCall('delegate', { input: 'invalid', rootJobId: 'spoof-root' }, { id: 'invalid-only' })])]);
  assert.equal((await f.coordinator.runStep('parent', parent.streamSimple)).lifecycle, 'ready');
  assert.equal(f.coordinator.children('parent').length, 0);
  assert.equal(f.coordinator.readJob('parent').steps, 1);
  const calls = f.store.readHistory('parent').find((entry) => entry.turn).turn.calls;
  assert.deepEqual(calls[0].arguments, { input: 'invalid', rootJobId: 'spoof-root' });
  assert.equal(calls[0].result.details.notExecuted, true);
  assert.equal(parent.state.callCount, 1);
});

test('SIGKILL immediately after parent cancellation transaction leaves every child fenced on restart', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-parent-cancel-crash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./parent-child-crash-fixture.js', import.meta.url)), root, 'cancel_accepted']);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const f = await coordinatorFixture(root, { bootId: 'restart' }); t.after(() => f.close());
  assert.equal(f.coordinator.readJob('parent').cancelRequested, true);
  const children = f.coordinator.children('parent');
  assert.equal(children.length, 2);
  assert.ok(children.every((child) => child.cancelRequested && child.lifecycle === 'cancelled'));
  const c = core([fauxAssistantMessage('must not run')]);
  for (const child of children) await assert.rejects(f.coordinator.runStep(child.jobId, c.streamSimple), /not ready/);
  assert.equal((await f.coordinator.recover('parent')).lifecycle, 'cancelled');
  assert.equal(c.state.callCount, 0);
});

test('restart parent scan derives child unknown usage from durable attempts and never completes parent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-child-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const crash = spawnSync(process.execPath, [fileURLToPath(new URL('./parent-child-crash-fixture.js', import.meta.url)), root, 'child_model']);
  assert.equal(crash.signal, 'SIGKILL', crash.stderr.toString());
  const f = await coordinatorFixture(root, { bootId: 'restart' }); t.after(() => f.close());
  assert.equal((await f.coordinator.recover('parent')).lifecycle, 'needs_attention');
  assert.equal((await f.coordinator.recover('parent')).lifecycle, 'needs_attention');
  const children = f.coordinator.children('parent');
  assert.equal(children[0].lifecycle, 'needs_attention');
  const c = core([fauxAssistantMessage('must not run')]);
  await assert.rejects(f.coordinator.runStep('parent', c.streamSimple), /not ready/);
  await assert.rejects(f.coordinator.runStep(children[0].jobId, c.streamSimple), /not ready/);
  assert.equal(c.state.callCount, 0);
  assert.equal(f.store.db.prepare('SELECT steps FROM runtime_roots WHERE root_job_id = ?').get('parent').steps, 1);
});
