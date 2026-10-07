import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { SqliteCheckpointStore } from './sqlite-checkpoint.js';
import { recoverTranscript, RecoveryBlockedError } from './transcript-recovery.js';
import { createPiSession, ROLE_TOOLS } from './pi-runtime.js';

for (const scenario of ['sqlite-only', 'jsonl-only', 'results', 'partial', 'cancelled']) {
  test(`SIGKILL recovery: ${scenario}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'worker-plane-recovery-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./recovery-crash-fixture.js', import.meta.url)), root, scenario]);
    assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
    const store = new SqliteCheckpointStore(join(root, 'state.sqlite'));
    t.after(() => store.close());
    let modelRequests = 0;
    let executions = 0;
    const recover = () => recoverTranscript({ store, jobId: 'job', cwd: root, sessionDir: join(root, 'recovered') });
    if (['sqlite-only', 'partial'].includes(scenario)) {
      assert.throws(recover, (error) => {
        assert.ok(error instanceof RecoveryBlockedError);
        assert.deepEqual(error.calls.map((call) => call.callId), scenario === 'partial' ? ['original-2'] : ['original-1', 'original-2']);
        return true;
      });
      assert.equal(modelRequests, 0);
      assert.equal(executions, 0);
      return;
    }
    const { sessionManager, messages } = recover();
    assert.equal(messages[0].content[0].text, 'Original user request');
    const results = messages.filter((message) => message.role === 'toolResult');
    assert.deepEqual(results.map((message) => message.toolCallId), scenario === 'jsonl-only' ? [] : ['original-1', 'original-2']);
    if (scenario === 'cancelled') assert.equal(messages.at(-1).stopReason, 'aborted');
    const reopened = SessionManager.open(sessionManager.getSessionFile());
    assert.deepEqual(reopened.buildSessionContext().messages, messages);
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
    await runtime.setRuntimeApiKey('openai', 'test-only');
    const { session } = await createPiSession({ role: 'worker', cwd: root, agentDir: join(root, 'agent'), sessionManager: reopened,
      model: getModel('openai', 'gpt-4o-mini'), modelRuntime: runtime,
      customTools: ROLE_TOOLS.worker.map((name) => ({ name, label: name, description: name, parameters: Type.Object({}), execute: async () => { executions++; return { content: [], details: {} }; } })),
      commitAssistantTurn: async () => { throw new Error('must not regenerate committed tools'); },
    });
    t.after(() => session.dispose());
    assert.equal(session.autoCompactionEnabled, false);
    const core = createFauxCore({ provider: 'recovery', api: 'recovery', models: [{ id: 'test' }] });
    core.setResponses([fauxAssistantMessage('continued')]);
    session.agent.streamFunction = (...args) => { modelRequests++; return core.streamSimple(...args); };
    if (scenario === 'cancelled') {
      await assert.rejects(session.agent.continue(), /Cannot continue/);
      assert.equal(modelRequests, 0, 'aborted response needs a new durable user message');
      store.appendHistory('job', 'resume-user', { role: 'user', content: 'Resume after cancellation', timestamp: 3 });
      await session.prompt('Resume after cancellation');
    } else await session.agent.continue();
    assert.equal(modelRequests, 1);
    assert.equal(executions, 0);
    assert.deepEqual(recover().messages.slice(0, messages.length), messages, 'repeated recovery uses SQLite only');
  });
}

test('durable base history is ordered, idempotent and required for legacy checkpoints', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-history-'));
  const store = new SqliteCheckpointStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const recover = () => recoverTranscript({ store, jobId: 'job', cwd: root, sessionDir: join(root, 'sessions') });
  assert.throws(recover, /durable user history/);
  const user = { role: 'user', content: 'request', timestamp: 1 };
  assert.equal(store.appendHistory('job', 'request', user), true);
  assert.throws(() => store.appendHistory('job', 'turn:reserved', user), /history requires/);
  assert.throws(() => store.appendHistory('job', 'system', { role: 'system', content: 'system' }), /history requires/);
  assert.throws(() => store.appendHistory('job', 'invalid-assistant', { role: 'assistant', content: 'text' }), /persistTurn/);
  assert.equal(store.appendHistory('job', 'request', user), false);
  assert.throws(() => store.appendHistory('job', 'request', { ...user, content: 'changed' }), /different contents/);
  store.appendHistory('job', 'answer', fauxAssistantMessage('original answer'));
  store.appendHistory('job', 'followup', { ...user, content: 'followup', timestamp: 2 });
  assert.deepEqual(recover().messages.map((m) => m.role), ['user', 'assistant', 'user']);
  store.persistTurn({ jobId: 'job', turnKey: 'empty', assistantMessage: fauxAssistantMessage('terminal'), calls: [] });
  store.db.prepare('DELETE FROM runtime_history WHERE turn_key = ?').run('empty');
  assert.throws(recover, /legacy turns/);
});

test('corrupt result identities and assistant intents refuse recovery', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-integrity-'));
  const store = new SqliteCheckpointStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.appendHistory('job', 'request', { role: 'user', content: 'request', timestamp: 1 });
  const assistant = fauxAssistantMessage([{ type: 'toolCall', id: 'original', name: 'read', arguments: { z: 1, a: 2 } }], { stopReason: 'toolUse' });
  store.persistTurn({ jobId: 'job', turnKey: 'turn', assistantMessage: assistant, calls: assistant.content });
  store.markDispatched('job', 'turn', 'original');
  store.recordResult('job', 'turn', 'original', { role: 'toolResult', toolCallId: 'wrong', toolName: 'read', content: [], isError: false, timestamp: 2 });
  const recover = () => recoverTranscript({ store, jobId: 'job', cwd: root, sessionDir: join(root, 'sessions') });
  assert.throws(recover, /matching identity/);
  store.db.prepare('UPDATE runtime_calls SET result_json = ?').run(JSON.stringify({ role: 'toolResult', toolCallId: 'original', toolName: 'read', content: [], isError: false, timestamp: 2 }));
  assert.equal(recover().messages.length, 3, 'object key sorting must not invalidate original arguments');
  store.db.prepare('UPDATE runtime_calls SET arguments_json = ?').run('{}');
  assert.throws(recover, /batch does not match/);
});

test('persisted legacy or malformed assistant content fails with RecoveryBlockedError', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'worker-plane-legacy-content-'));
  const store = new SqliteCheckpointStore(join(root, 'state.sqlite'));
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  for (const [index, content] of ['legacy string content', null, [null], ['invalid block'], [[]]].entries()) {
    const jobId = `job-${index}`;
    store.appendHistory(jobId, 'request', { role: 'user', content: 'request', timestamp: 1 });
    store.persistTurn({ jobId, turnKey: 'legacy', assistantMessage: { role: 'assistant', content }, calls: [] });
    assert.throws(() => recoverTranscript({ store, jobId, cwd: root, sessionDir: join(root, 'sessions') }), (error) => {
      assert.ok(error instanceof RecoveryBlockedError);
      assert.match(error.message, /assistant content must be an array/);
      return true;
    });
  }
});
