import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createFauxCore, createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { coordinatorFixture } from './coordinator-test-support.js';
import { recoverTranscript } from './transcript-recovery.js';
function core(messages) { const c = createFauxCore({ provider: 'interruption', api: 'interruption', models: [{ id: 'test' }] }); c.setResponses(messages); return c; }
async function crashed(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-interrupted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./interruption-crash-fixture.js', import.meta.url)), root]);
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
  const f = await coordinatorFixture(root, { bootId: 'new-boot', ...options });
  t.after(() => f.close()); return { root, ...f };
}
const resolution = { jobId: 'job', generation: 1, verifiedUsage: { inputTokens: 8, outputTokens: 2 }, evidence: { source: 'test-provider-usage', reference: 'original-request-1' }, prompt: 'Retry the interrupted request' };

test('partial tool draft SIGKILL archives interrupted history, explicit verified retry executes only new intent', async (t) => {
  const effects = [];
  const f = await crashed(t, { execute: async (request) => { effects.push(request.callId); return { content: [] }; } });
  assert.equal(f.coordinator.drafts('job')[0].status, 'streaming');
  assert.ok(f.coordinator.drafts('job')[0].message.content.some((part) => part.id === 'draft-old-call'));
  assert.equal((await f.coordinator.recover('job')).lifecycle, 'needs_attention');
  assert.equal(f.coordinator.drafts('job')[0].status, 'interrupted');
  const aborted = f.store.readHistory('job').at(-1).message;
  assert.equal(aborted.stopReason, 'aborted'); assert.ok(aborted.content.every((part) => part.type !== 'toolCall'));
  assert.equal(f.coordinator.resolveInterrupted(resolution).lifecycle, 'ready');
  assert.equal(f.coordinator.resolveInterrupted(resolution).lifecycle, 'ready');
  assert.equal(f.coordinator.readJob('job').inputTokens, 8);
  assert.equal(f.coordinator.readJob('job').outputTokens, 2);
  assert.equal(f.coordinator.readJob('job').steps, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_attempts').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_usage_resolutions WHERE original_unknown = 1').get().n, 1);
  assert.throws(() => f.coordinator.resolveInterrupted({ ...resolution, verifiedUsage: { inputTokens: 9, outputTokens: 2 } }), /conflict/);
  const c = core([fauxAssistantMessage([fauxToolCall('write', { input: 'new' }, { id: 'new-committed-call' })], { stopReason: 'toolUse' })]);
  await f.coordinator.runStep('job', c.streamSimple);
  assert.deepEqual(effects, ['new-committed-call']);
  assert.equal(c.state.callCount, 1);
  assert.ok(f.coordinator.readJob('job').inputTokens >= 8 && f.coordinator.readJob('job').outputTokens >= 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_attempts').get().n, 2);
  const projection = recoverTranscript({ store: f.store, jobId: 'job', cwd: f.root, sessionDir: join(f.root, 'reloaded') });
  assert.deepEqual(SessionManager.open(projection.sessionManager.getSessionFile()).buildSessionContext().messages, projection.messages);
});

for (const limit of ['attempt', 'token']) {
  test(`verified retry cannot reset ${limit} budget or erase unknown-usage audit`, async (t) => {
    const f = await crashed(t); await f.coordinator.recover('job');
    f.store.db.prepare(limit === 'attempt' ? 'UPDATE runtime_roots SET max_steps = 1' : 'UPDATE runtime_roots SET max_tokens = 10').run();
    assert.equal(f.coordinator.resolveInterrupted(resolution).lifecycle, 'budget_exceeded');
    assert.equal(f.coordinator.readJob('job').steps, 1);
    assert.equal(f.coordinator.readJob('job').inputTokens, 8);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM coordinator_usage_resolutions').get().n, 1);
    const c = core([fauxAssistantMessage('must not run')]); await assert.rejects(f.coordinator.runStep('job', c.streamSimple), /not ready/); assert.equal(c.state.callCount, 0);
  });
}

test('retry rejects unknown worker execution and unresolved children without spending supplied usage', async (t) => {
  const f = await crashed(t); await f.coordinator.recover('job');
  const request = { jobId: 'job', turnKey: 'unknown', sessionId: 'session', callId: 'unresolved', callSeq: 1, workerId: 'worker', ledgerId: f.ledger.identity.ledgerId, workspaceId: 'workspace', workspaceVersion: 'v1', toolName: 'write', arguments: {}, timeoutMs: 1000 };
  f.ledger.accept(request); f.ledger.start(request);
  assert.throws(() => f.coordinator.resolveInterrupted(resolution), /worker execution remains unresolved/);
  assert.equal(f.coordinator.readJob('job').inputTokens, 0);
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-retry-children-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const parent = await coordinatorFixture(root); t.after(() => parent.close());
  parent.coordinator.createJob({ jobId: 'parent', role: 'main', maxTokens: 100000, maxSteps: 10, prompt: 'delegate' });
  const c = core([fauxAssistantMessage([fauxToolCall('delegate', { input: 'child' }, { id: 'delegate' })], { stopReason: 'toolUse' })]);
  await parent.coordinator.runStep('parent', c.streamSimple);
  parent.store.db.prepare("UPDATE coordinator_jobs SET status = 'needs_attention' WHERE job_id = 'parent'").run();
  assert.throws(() => parent.coordinator.resolveInterrupted({ ...resolution, jobId: 'parent' }), /unresolved execution or children/);
});

async function draftSession(t, { oversized = false, interrupted = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-draft-cancel-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = await coordinatorFixture(root); t.after(() => f.close());
  f.coordinator.createJob({ jobId: 'job', maxTokens: 100000, maxSteps: 10, prompt: 'original' });
  let started; const start = new Promise((resolve) => { started = resolve; }); let send;
  const partial = fauxAssistantMessage([{ type: 'text', text: oversized ? 'x'.repeat(90000) : 'partial before cancellation' }, fauxToolCall('write', { input: 'old' }, { id: 'cancelled-draft-call' })], { stopReason: 'toolUse' });
  const running = f.coordinator.runStep('job', () => {
    const stream = createAssistantMessageEventStream();
    send = (message) => { stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: '{}', partial: message }); stream.push({ type: 'done', reason: 'toolUse', message }); };
    queueMicrotask(() => { stream.push({ type: 'start', partial }); stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: '{}', partial }); setTimeout(started, 5); });
    if (interrupted) queueMicrotask(() => stream.push({ type: 'error', reason: 'aborted', error: { ...partial, stopReason: 'aborted' } }));
    return stream;
  });
  await start; return { root, ...f, running, send, partial };
}

test('task cancellation archives bounded draft, reloads aborted history, late updates cannot change it', async (t) => {
  const f = await draftSession(t, { oversized: true });
  const cancellation = f.coordinator.cancel('job');
  const snapshot = f.coordinator.drafts('job')[0];
  assert.equal(snapshot.status, 'cancelled'); assert.equal(snapshot.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.message)) <= 65536);
  f.send({ ...f.partial, content: [{ type: 'text', text: 'late' }, fauxToolCall('write', {}, { id: 'late-draft-call' })] });
  await cancellation; await f.running;
  assert.deepEqual(f.coordinator.drafts('job')[0], snapshot);
  assert.equal(f.coordinator.readJob('job').lifecycle, 'cancelled');
  assert.throws(() => f.coordinator.resolveInterrupted(resolution), /only interrupted/);
  const projection = recoverTranscript({ store: f.store, jobId: 'job', cwd: f.root, sessionDir: join(f.root, 'reload') });
  assert.equal(SessionManager.open(projection.sessionManager.getSessionFile()).buildSessionContext().messages.at(-1).stopReason, 'aborted');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM runtime_calls').get().n, 0);
});

test('already interrupted archival remains immutable when task cancellation follows', async (t) => {
  const f = await draftSession(t, { interrupted: true }); await f.running;
  assert.equal(f.coordinator.readJob('job').lifecycle, 'needs_attention');
  const before = f.coordinator.drafts('job')[0]; const history = f.store.readHistory('job');
  await f.coordinator.cancel('job');
  assert.equal(f.coordinator.readJob('job').lifecycle, 'cancelled');
  assert.deepEqual(f.coordinator.drafts('job')[0], before); assert.deepEqual(f.store.readHistory('job'), history);
});

test('cancelled committed batch reopens with factual result and never-executed pairing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-cancel-reopen-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let release, started;
  const start = new Promise((resolve) => { started = resolve; });
  const first = await coordinatorFixture(root, { execute: async () => {
    started(); await new Promise((resolve) => { release = resolve; });
    return { content: [{ type: 'text', text: 'actual completion' }] };
  } });
  first.coordinator.createJob({ jobId: 'job', maxTokens: 100000, maxSteps: 10, prompt: 'cancel batch' });
  const provider = core([fauxAssistantMessage([
    fauxToolCall('write', {}, { id: 'completed-original' }),
    fauxToolCall('read', {}, { id: 'not-executed-original' }),
  ], { stopReason: 'toolUse' })]);
  const run = first.coordinator.runStep('job', provider.streamSimple);
  await start;
  const cancel = first.coordinator.cancel('job');
  release(); await cancel; await run;
  await first.coordinator.recover('job'); first.close();
  const reopened = await coordinatorFixture(root, { bootId: 'reopened' });
  t.after(() => reopened.close());
  assert.equal((await reopened.coordinator.recover('job')).lifecycle, 'cancelled');
  const projection = recoverTranscript({ store: reopened.store, jobId: 'job', cwd: root, sessionDir: join(root, 'cancelled-reload') });
  const messages = SessionManager.open(projection.sessionManager.getSessionFile()).buildSessionContext().messages;
  const results = messages.filter((message) => message.role === 'toolResult');
  assert.deepEqual(results.map((message) => message.toolCallId), ['completed-original', 'not-executed-original']);
  assert.equal(results[0].content[0].text, 'actual completion');
  assert.equal(results[1].details.notExecuted, true);
  const next = core([fauxAssistantMessage('must not run')]);
  await assert.rejects(reopened.coordinator.runStep('job', next.streamSimple), /not ready/);
  assert.equal(next.state.callCount, 0);
});
