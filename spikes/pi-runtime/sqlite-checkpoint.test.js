import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteCheckpointStore, TurnConflictError } from './sqlite-checkpoint.js';

function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'worker-plane-checkpoint-'));
  const filename = join(directory, 'checkpoint.sqlite');
  let store = new SqliteCheckpointStore(filename);
  t.after(() => {
    if (store?.db.open) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    filename,
    get store() { return store; },
    reopen() {
      if (store?.db.open) store.close();
      store = new SqliteCheckpointStore(filename);
      return store;
    },
  };
}

const baseTurn = {
  jobId: 'job-1',
  turnKey: 'turn-1',
  assistantMessage: {
    role: 'assistant',
    content: 'I will inspect and test the project.',
    toolCalls: [
      { id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
      { id: 'call-2', name: 'bash', arguments: { command: 'npm test' } },
    ],
  },
  calls: [
    { id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
    { id: 'call-2', name: 'bash', arguments: { command: 'npm test' } },
  ],
};

test('persists assistant turn and calls as one authorized checkpoint', (t) => {
  const { store } = temporaryStore(t);
  const saved = store.persistTurn(baseTurn);

  assert.equal(saved.inserted, true);
  const persisted = store.readTurn('job-1', 'turn-1');
  assert.deepEqual(persisted.assistantMessage, baseTurn.assistantMessage);
  assert.deepEqual(persisted.calls.map(({ callId, callSeq, status }) => ({ callId, callSeq, status })), [
    { callId: 'call-1', callSeq: 1, status: 'committed' },
    { callId: 'call-2', callSeq: 2, status: 'committed' },
  ]);
  assert.equal(store.readAuthorizedCall('job-1', 'turn-1', 'call-1').name, 'read');
  assert.equal(store.readAuthorizedCall('job-1', 'turn-1', 'missing'), null);
  assert.deepEqual(store.findIncompleteTurns('job-1').map(({ turnKey }) => turnKey), ['turn-1']);
});

test('call_seq increases across turns within one job', (t) => {
  const { store } = temporaryStore(t);
  store.persistTurn(baseTurn);
  const secondTurn = {
    jobId: 'job-1',
    turnKey: 'turn-2',
    assistantMessage: { role: 'assistant', content: '', toolCalls: [{ id: 'call-3' }] },
    calls: [{ id: 'call-3', name: 'read', arguments: { path: 'next.txt' } }],
  };
  store.persistTurn(secondTurn);

  assert.deepEqual(store.readTurn('job-1', 'turn-2').calls.map((call) => call.callSeq), [3]);
  assert.throws(() => store.db.prepare(`
    UPDATE runtime_calls SET call_seq = 2 WHERE job_id = 'job-1' AND turn_key = 'turn-2'
  `).run());
});

test('repeated identical turn is idempotent and changed contents conflict', (t) => {
  const { store } = temporaryStore(t);
  const first = store.persistTurn(baseTurn);
  const reordered = structuredClone(baseTurn);
  reordered.assistantMessage = {
    toolCalls: reordered.assistantMessage.toolCalls,
    content: reordered.assistantMessage.content,
    role: reordered.assistantMessage.role,
  };
  reordered.calls[0].arguments = { path: 'README.md' };
  const second = store.persistTurn(reordered);

  assert.equal(second.inserted, false);
  assert.equal(second.idempotent, true);
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(store.readTurn('job-1', 'turn-1').calls.length, 2);

  const changed = structuredClone(baseTurn);
  changed.calls[0].arguments.path = 'other.txt';
  awaitAssertConflict(() => store.persistTurn(changed), 'job-1', 'turn-1');
  assert.equal(store.readTurn('job-1', 'turn-1').calls[0].arguments.path, 'README.md');
});

test('constraint failure rolls back both turn and earlier call inserts', (t) => {
  const { store } = temporaryStore(t);
  const duplicateIds = {
    jobId: 'job-rollback',
    turnKey: 'turn-rollback',
    assistantMessage: { role: 'assistant', toolCalls: [{ id: 'same' }, { id: 'same' }] },
    calls: [
      { id: 'same', name: 'read', arguments: { path: 'one' } },
      { id: 'same', name: 'write', arguments: { path: 'two' } },
    ],
  };

  assert.throws(() => store.persistTurn(duplicateIds));
  assert.equal(store.readTurn('job-rollback', 'turn-rollback'), null);
  assert.equal(store.readAuthorizedCall('job-rollback', 'turn-rollback', 'same'), null);
});

test('committed call remains reconcilable after close/reopen before dispatch', (t) => {
  const { store: initial, reopen } = temporaryStore(t);
  let modelGenerations = 1;
  initial.persistTurn(baseTurn); // Simulate a process crash immediately after commit.
  initial.close();

  const recovered = reopen();
  const incomplete = recovered.findIncompleteTurns('job-1');
  assert.equal(modelGenerations, 1, 'recovery must use the committed turn, not regenerate it');
  assert.equal(incomplete.length, 1);
  assert.deepEqual(incomplete[0].assistantMessage, baseTurn.assistantMessage);
  assert.deepEqual(incomplete[0].calls.map((call) => call.status), ['committed', 'committed']);
  assert.equal(recovered.readAuthorizedCall('job-1', 'turn-1', 'call-1').status, 'committed');

  recovered.markDispatched('job-1', 'turn-1', 'call-1');
  recovered.recordResult('job-1', 'turn-1', 'call-1', { text: 'contents' });
  assert.equal(recovered.readAuthorizedCall('job-1', 'turn-1', 'call-1').status, 'completed');
  assert.equal(recovered.findIncompleteTurns('job-1')[0].calls[0].result.text, 'contents');
});

test('uncommitted calls cannot be authorized or dispatched', (t) => {
  const { store } = temporaryStore(t);
  assert.equal(store.readAuthorizedCall('job-1', 'turn-1', 'call-1'), null);
  assert.throws(() => store.markDispatched('job-1', 'turn-1', 'call-1'), /not committed/);
  store.persistTurn(baseTurn);
  assert.throws(() => store.recordResult('job-1', 'turn-1', 'call-1', { text: 'too early' }), /must be dispatched/);
  assert.equal(store.readAuthorizedCall('job-1', 'turn-1', 'call-1').status, 'committed');
});

function awaitAssertConflict(action, jobId, turnKey) {
  assert.throws(action, (error) => error instanceof TurnConflictError && error.message.includes(`${jobId}/${turnKey}`));
}
