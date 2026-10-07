import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { SqliteCheckpointStore } from './sqlite-checkpoint.js';
import { SqliteWorkerLedger, WorkerReconciler, requestHash } from './worker-ledger.js';
import { recoverTranscript, RecoveryBlockedError } from './transcript-recovery.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-ledger-'));
  const host = new SqliteCheckpointStore(join(root, 'host.sqlite'));
  const worker = new SqliteWorkerLedger(join(root, 'worker.sqlite'), { workerId: 'worker', bootId: 'first-boot' });
  t.after(() => { if (host.db.open) host.close(); if (worker.db.open) worker.close(); rmSync(root, { recursive: true, force: true }); });
  host.appendHistory('job', 'user', { role: 'user', content: 'run original calls', timestamp: 1 });
  const assistant = fauxAssistantMessage([fauxToolCall('write', { input: 'original' }, { id: 'call-1' }), fauxToolCall('read', { input: 'later' }, { id: 'call-2' })], { stopReason: 'toolUse' });
  host.persistTurn({ jobId: 'job', turnKey: 'turn', assistantMessage: assistant, calls: assistant.content });
  const reconciler = new WorkerReconciler(host);
  const target = { workerId: 'worker', ledgerId: worker.identity.ledgerId, workspaceId: 'workspace', workspaceVersion: 'v1' };
  const requests = ['call-1', 'call-2'].map((callId) => reconciler.bind({ jobId: 'job', turnKey: 'turn', callId, trustedTarget: target, sessionId: 'session', timeoutMs: 1000 }));
  const reconcile = (callId = 'call-1', ledger = worker, verifiedIdentity = ledger.identity) => reconciler.reconcile({ jobId: 'job', turnKey: 'turn', callId, ledger, verifiedIdentity });
  return { root, host, worker, reconciler, requests, target, reconcile };
}
const result = (request) => ({ role: 'toolResult', toolCallId: request.callId, toolName: request.toolName, content: [{ type: 'text', text: 'original cached result' }], isError: false, timestamp: 2 });

test('trusted same-ledger absence grants original dispatch, then accepted/running holds serial batch', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.reconcile(), { action: 'dispatch_same_request', request: f.requests[0] });
  assert.equal(f.reconcile('call-2').action, 'wait');
  f.worker.accept(f.requests[0]);
  assert.equal(f.reconcile().action, 'observe');
  assert.equal(f.reconcile().status, 'accepted');
  f.worker.start(f.requests[0]);
  assert.equal(f.reconcile().status, 'running');
  assert.equal(f.reconcile('call-2').action, 'wait');
  assert.throws(() => f.worker.accept(f.requests[1]), /unresolved active/);
  assert.throws(() => recoverTranscript({ store: f.host, jobId: 'job', cwd: f.root, sessionDir: join(f.root, 'sessions') }), RecoveryBlockedError);
  f.worker.complete(f.requests[0], result(f.requests[0]));
  assert.equal(f.reconcile().action, 'completed');
  assert.equal(f.reconcile().action, 'completed', 'cached import is idempotent');
  assert.equal(f.reconcile('call-2').action, 'dispatch_same_request');
  f.worker.accept(f.requests[1]); f.worker.start(f.requests[1]); f.worker.complete(f.requests[1], result(f.requests[1]));
  assert.equal(f.reconcile('call-2').action, 'completed');
  const history = recoverTranscript({ store: f.host, jobId: 'job', cwd: f.root, sessionDir: join(f.root, 'sessions') });
  assert.deepEqual(history.messages.filter((m) => m.role === 'toolResult').map((m) => m.toolCallId), ['call-1', 'call-2']);
});

for (const mode of ['before_accept', 'accepted', 'running', 'effect', 'completed']) {
  test(`independent SIGKILL worker ${mode} window never duplicates side effects`, (t) => {
    const f = fixture(t);
    f.worker.close();
    f.host.markDispatched('job', 'turn', 'call-1');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./worker-ledger-crash-fixture.js', import.meta.url)), f.root, mode, JSON.stringify(f.requests[0])]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    f.host.close();
    const reopenedHost = new SqliteCheckpointStore(join(f.root, 'host.sqlite'));
    const rebooted = new SqliteWorkerLedger(join(f.root, 'worker.sqlite'), { workerId: 'worker', bootId: 'new-boot' });
    t.after(() => { reopenedHost.close(); rebooted.close(); });
    const reconcile = new WorkerReconciler(reopenedHost);
    const outcome = reconcile.reconcile({ jobId: 'job', turnKey: 'turn', callId: 'call-1', verifiedIdentity: rebooted.identity, ledger: rebooted });
    assert.equal(outcome.action, mode === 'completed' ? 'completed' : mode === 'before_accept' ? 'dispatch_same_request' : 'needs_attention');
    assert.throws(() => rebooted.start(f.requests[0]), /cannot safely start/);
    assert.equal(existsSync(join(f.root, 'effects.log')) ? readFileSync(join(f.root, 'effects.log'), 'utf8') : '', ['effect', 'completed'].includes(mode) ? 'call-1\n' : '');
    if (mode === 'completed') assert.deepEqual(reopenedHost.readAuthorizedCall('job', 'turn', 'call-1').result, result(f.requests[0]));
    else assert.equal(reopenedHost.readAuthorizedCall('job', 'turn', 'call-1').status, 'dispatched');
    assert.equal(reconcile.reconcile({ jobId: 'job', turnKey: 'turn', callId: 'call-2', verifiedIdentity: rebooted.identity, ledger: rebooted }).action, mode === 'completed' ? 'dispatch_same_request' : 'wait');
  });
}

test('retained floor, ledger loss/change, hash contradictions and missing bindings block', (t) => {
  const f = fixture(t);
  f.worker.accept(f.requests[0]); f.worker.start(f.requests[0]); f.worker.complete(f.requests[0], result(f.requests[0]));
  f.worker.retireThrough('job', 1);
  assert.equal(f.reconcile().action, 'needs_attention');
  f.host.markDispatched('job', 'turn', 'call-1');
  assert.throws(() => f.worker.accept(f.requests[0]), /deduplication proof/);
  assert.throws(() => f.worker.accept({ ...f.requests[0], jobId: 'another-job' }), /deduplication proof/, 'retired call IDs retain cross-job dedup proof');
  assert.equal(f.reconcile('call-1', f.worker, { ...f.worker.identity, ledgerId: 'changed' }).action, 'needs_attention');
  const replacement = new SqliteWorkerLedger(join(f.root, 'replacement.sqlite'), { workerId: 'worker', bootId: 'replacement-boot' });
  t.after(() => replacement.close());
  assert.notEqual(replacement.identity.ledgerId, f.worker.identity.ledgerId);
  assert.equal(f.reconcile('call-1', replacement, replacement.identity).action, 'needs_attention', 'fresh real SQLite ledger cannot prove absence in the original ledger');
  assert.equal(f.reconcile('call-1', { identity: f.worker.identity, observe() { throw new Error('lost'); } }).action, 'needs_attention');
  assert.equal(f.reconcile('call-1', f.worker, null).action, 'needs_attention');
  f.host.db.prepare('DELETE FROM host_worker_bindings WHERE call_id = ?').run('call-1');
  assert.equal(f.reconcile().action, 'needs_attention');
  assert.throws(() => f.reconciler.bind({ jobId: 'job', turnKey: 'turn', callId: 'call-1', trustedTarget: f.target, sessionId: 'session', timeoutMs: 1000 }), /cannot infer original binding/);
  assert.throws(() => f.reconciler.bind({ jobId: 'job', turnKey: 'turn', callId: 'call-2', trustedTarget: { ...f.target, ledgerId: 'replacement' }, sessionId: 'session', timeoutMs: 1000 }), /binding conflict/);
  const f2 = fixture(t);
  f2.worker.accept({ ...f2.requests[0], arguments: { input: 'wrong' } });
  assert.equal(f2.reconcile().reason, 'worker request contradiction');
});

test('worker identity, sequence, cross-job call ID and results have strict conflict guards', (t) => {
  const f = fixture(t);
  f.worker.accept(f.requests[0]);
  assert.throws(() => f.worker.accept({ ...f.requests[0], arguments: {} }), /request conflict/);
  assert.throws(() => f.worker.accept({ ...f.requests[0], jobId: 'another' }), /deduplication proof/);
  assert.throws(() => f.worker.accept({ ...f.requests[0], callId: 'other' }), /deduplication proof/);
  f.worker.start(f.requests[0]);
  assert.throws(() => f.worker.complete(f.requests[0], { ...result(f.requests[0]), toolCallId: 'wrong' }), /identity/);
  f.worker.complete(f.requests[0], result(f.requests[0]));
  assert.equal(f.worker.complete(f.requests[0], result(f.requests[0])), false);
  assert.throws(() => f.worker.complete(f.requests[0], { ...result(f.requests[0]), content: [] }), /result conflict/);
  f.host.markDispatched('job', 'turn', 'call-1');
  f.host.recordResult('job', 'turn', 'call-1', { ...result(f.requests[0]), content: [] });
  assert.equal(f.reconcile().reason, 'local result contradiction');
});

test('provisional request hashes use fixed JSON key ordering and reject coerced values', () => {
  assert.equal(requestHash({ b: [2, null], a: 'x' }), requestHash({ a: 'x', b: [2, null] }));
  assert.equal(requestHash({ a: 1 }), '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  assert.throws(() => requestHash({ value: undefined }), /finite JSON/);
  assert.throws(() => requestHash({ value: Infinity }), /finite JSON/);
  assert.throws(() => requestHash(new Array(2)), /sparse/);
  const decoratedSparse = new Array(1); decoratedSparse.extra = 'not an index';
  assert.throws(() => requestHash(decoratedSparse), /sparse/);
});
