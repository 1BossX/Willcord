import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import { createPiSession, ROLE_TOOLS } from './pi-runtime.js';
import { SqliteCheckpointStore } from './sqlite-checkpoint.js';

async function makeRuntime(root) {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(root, 'test-auth.json'),
    modelsPath: null,
    modelsStorePath: join(root, 'test-models.json'),
    refreshOnCreate: false,
  });
  // This fake value lives only in the temporary test directory. The provider
  // stream is replaced below, so no network model request can be made.
  await modelRuntime.setRuntimeApiKey('openai', 'p0-test-only');
  return modelRuntime;
}

function makeTools(role, execute) {
  return ROLE_TOOLS[role].map((name) => ({
    name,
    label: name,
    description: `P0 fake ${name}`,
    parameters: Type.Object({ input: Type.Optional(Type.String()) }),
    execute: async (toolCallId, params, signal) => execute({ name, toolCallId, params, signal }),
  }));
}

async function makeSession({ role, root, execute, commitAssistantTurn, onAssistantTurn, sessionManager }) {
  const cwd = root;
  const manager = sessionManager ?? SessionManager.create(cwd, join(root, 'sessions'));
  const { session } = await createPiSession({
    role,
    cwd,
    agentDir: join(root, 'agent'),
    sessionManager: manager,
    model: getModel('openai', 'gpt-4o-mini'),
    modelRuntime: await makeRuntime(root),
    customTools: makeTools(role, execute),
    commitAssistantTurn,
    onAssistantTurn,
  });
  return { session, sessionManager: manager };
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'worker-plane-pi-'));
  t.after(async () => {
    // Tests use OS temporary storage for fake auth and session files only.
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('actual Pi session exposes only the requested role tools and no built-ins', async (t) => {
  const root = await tempRoot(t);
  for (const role of ['main', 'worker']) {
    const { session } = await makeSession({
      role,
      root: join(root, role),
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
      commitAssistantTurn: async () => {},
    });
    t.after(() => session.dispose());
    assert.deepEqual([...session.getActiveToolNames()].sort(), [...ROLE_TOOLS[role]].sort());
    assert.equal(session.getActiveToolNames().some((name) => ['bash', 'read', 'write', 'edit'].includes(name) && role === 'main'), false);
  }
});

test('Pi commits the whole assistant tool batch before any tool callback and restores its history', async (t) => {
  const root = await tempRoot(t);
  const journal = [];
  let checkpoint;
  let core;
  const committedTurns = new Set();
  const { session, sessionManager } = await makeSession({
    role: 'worker',
    root,
    commitAssistantTurn: async (entry) => {
      const repeated = committedTurns.has(entry.turnKey);
      committedTurns.add(entry.turnKey);
      journal.push(`${repeated ? 'commit-repeat' : 'commit'}:${entry.turnKey}`);
      checkpoint = structuredClone(entry.assistantMessage);
      assert.equal(entry.calls.length, 2);
    },
    execute: async ({ toolCallId, params }) => {
      assert.ok(checkpoint, 'durable assistant checkpoint must precede execution');
      assert.deepEqual(checkpoint.content.filter((block) => block.type === 'toolCall').map((call) => call.id), ['c1', 'c2']);
      assert.equal(core.state.callCount >= 0, true);
      journal.push(`execute:${toolCallId}`);
      return { content: [{ type: 'text', text: params.input ?? '' }], details: { toolCallId } };
    },
  });
  t.after(() => session.dispose());

  core = createFauxCore({ provider: 'p0', api: 'p0', models: [{ id: 'p0-model' }] });
  core.setResponses([
    fauxAssistantMessage([
      fauxToolCall('read', { input: 'first' }, { id: 'c1' }),
      fauxToolCall('write', { input: 'second' }, { id: 'c2' }),
    ], { stopReason: 'toolUse' }),
    fauxAssistantMessage('finished'),
  ]);
  session.agent.streamFunction = core.streamSimple;
  await session.prompt('run the remote tools');

  assert.equal(journal[0].startsWith('commit:'), true);
  assert.deepEqual(journal.slice(1).map((entry) => entry.split(':')[0]), ['execute', 'commit-repeat', 'execute']);
  assert.equal(journal.at(-1), 'execute:c2');
  assert.equal(core.state.callCount, 1, 'the host controls when Pi begins another model turn');

  const sessionFile = sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const restored = SessionManager.open(sessionFile);
  const messages = restored.buildSessionContext().messages;
  const assistant = messages.find((message) => message.role === 'assistant' && message.content.some((part) => part.type === 'toolCall'));
  assert.deepEqual(assistant.content.filter((part) => part.type === 'toolCall').map((call) => call.id), ['c1', 'c2']);
  assert.equal(messages.filter((message) => message.role === 'toolResult').length, 2);

  const resumed = await makeSession({
    role: 'worker',
    root,
    sessionManager: restored,
    commitAssistantTurn: async () => {},
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  });
  t.after(() => resumed.session.dispose());
  resumed.session.agent.streamFunction = core.streamSimple;
  assert.deepEqual(
    resumed.session.agent.state.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'toolResult', 'toolResult'],
  );

  await resumed.session.agent.continue();
  assert.equal(core.state.callCount, 2);
});

test('real Pi tool hook is gated by a durable SQLite checkpoint before execution', async (t) => {
  const root = await tempRoot(t);
  const checkpointPath = join(root, 'checkpoint.sqlite');
  let store = new SqliteCheckpointStore(checkpointPath);
  t.after(() => { if (store?.db.open) store.close(); });
  let executionCount = 0;
  const { session } = await makeSession({
    role: 'worker',
    root,
    commitAssistantTurn: async ({ turnKey, assistantMessage, calls, currentCallId }) => {
      store.persistTurn({ jobId: 'job-1', turnKey, assistantMessage, calls });
      const committed = store.readAuthorizedCall('job-1', turnKey, currentCallId);
      return Boolean(committed && committed.status === 'committed');
    },
    execute: async ({ toolCallId }) => {
      executionCount += 1;
      const pending = store.findIncompleteTurns('job-1').flatMap((turn) => turn.calls);
      assert.ok(pending.some((call) => call.callId === toolCallId && call.status === 'committed'));
      return { content: [{ type: 'text', text: 'durably authorized' }], details: {} };
    },
  });
  t.after(() => session.dispose());

  const core = createFauxCore({ provider: 'p0', api: 'p0', models: [{ id: 'p0-model' }] });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { input: 'side effect' }, { id: 'durable-call' }), { stopReason: 'toolUse' }),
  ]);
  session.agent.streamFunction = core.streamSimple;
  await session.prompt('run one durable call');

  assert.equal(executionCount, 1);
  const beforeDispatch = store.findIncompleteTurns('job-1')[0];
  assert.equal(beforeDispatch.calls[0].status, 'committed');
  store.close();
  store = new SqliteCheckpointStore(checkpointPath);
  const afterRestart = store.findIncompleteTurns('job-1')[0];
  assert.equal(afterRestart.calls[0].callId, 'durable-call');
  assert.equal(afterRestart.calls[0].status, 'committed');
  assert.equal(executionCount, 1, 'recovery inspects the existing call and does not execute it again');
});

test('a host token budget decision blocks the entire assistant tool batch', async (t) => {
  const root = await tempRoot(t);
  let executions = 0;
  let accountedTokens = 0;
  const { session } = await makeSession({
    role: 'worker',
    root,
    commitAssistantTurn: async ({ assistantMessage }) => {
      const proposed = accountedTokens + assistantMessage.usage.totalTokens;
      if (proposed > 10) return false;
      accountedTokens = proposed;
      return true;
    },
    execute: async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'should not run' }], details: {} };
    },
  });
  t.after(() => session.dispose());

  const core = createFauxCore({ provider: 'p0', api: 'p0', models: [{ id: 'p0-model' }] });
  const overBudget = fauxAssistantMessage(
    fauxToolCall('bash', { input: 'side effect' }, { id: 'over-budget-call' }),
    { stopReason: 'toolUse' },
  );
  overBudget.usage.totalTokens = 11;
  core.setResponses([overBudget]);
  session.agent.streamFunction = core.streamSimple;
  await session.prompt('exceed budget');

  assert.equal(executions, 0);
  assert.equal(accountedTokens, 0);
  assert.ok(session.agent.state.messages.some((message) => message.role === 'toolResult' && message.isError));
});

test('a delegate result can end the Pi run and be resumed from its persisted session', async (t) => {
  const root = await tempRoot(t);
  let createdChildren = 0;
  const { session, sessionManager } = await makeSession({
    role: 'main',
    root,
    commitAssistantTurn: async () => {},
    execute: async () => {
      createdChildren += 1;
      return {
        content: [{ type: 'text', text: 'child job accepted: child-1' }],
        details: { childJobId: 'child-1' },
        terminate: true,
      };
    },
  });
  t.after(() => session.dispose());

  const core = createFauxCore({ provider: 'p0', api: 'p0', models: [{ id: 'p0-model' }] });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall('delegate', { input: 'run tests' }, { id: 'delegate-1' }), { stopReason: 'toolUse' }),
  ]);
  session.agent.streamFunction = core.streamSimple;
  await session.prompt('delegate this task');

  assert.equal(createdChildren, 1);
  assert.equal(core.state.callCount, 1, 'Pi must stop after the durable delegate acceptance result');
  const sessionFile = sessionManager.getSessionFile();
  const restoredManager = SessionManager.open(sessionFile);
  assert.ok(restoredManager.buildSessionContext().messages.some((message) => message.role === 'toolResult'));
});

test('session abort propagates to the provider stream and settles without executing a tool', async (t) => {
  const root = await tempRoot(t);
  let observedSignal;
  let executions = 0;
  const { session } = await makeSession({
    role: 'worker',
    root,
    commitAssistantTurn: async () => {},
    execute: async () => {
      executions += 1;
      return { content: [], details: {} };
    },
  });
  t.after(() => session.dispose());

  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  session.agent.streamFunction = (_model, _context, options) => {
    observedSignal = options.signal;
    markStarted();
    const stream = createAssistantMessageEventStream();
    observedSignal.addEventListener('abort', () => {
      stream.push({
        type: 'error',
        reason: 'aborted',
        error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted by test' }),
      });
    }, { once: true });
    return stream;
  };

  const prompt = session.prompt('wait for a model');
  await started;
  await session.abort();
  await prompt;

  assert.equal(observedSignal.aborted, true);
  assert.equal(executions, 0);
  assert.equal(session.isIdle, true);
});
