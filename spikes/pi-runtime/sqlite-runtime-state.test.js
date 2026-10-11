import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStateError, SqliteRuntimeStateStore } from './sqlite-runtime-state.js';

function temporaryStore(t) {
  const directory = mkdtempSync(join(tmpdir(), 'willcord-runtime-state-'));
  const filename = join(directory, 'runtime.sqlite');
  let store = new SqliteRuntimeStateStore(filename);
  t.after(() => {
    if (store?.db.open) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; },
    reopen() {
      if (store?.db.open) store.close();
      store = new SqliteRuntimeStateStore(filename);
      return store;
    },
  };
}

test('job and root usage limits persist across generations and database reopen', (t) => {
  const fixture = temporaryStore(t);
  const { store } = fixture;
  store.createJob({ jobId: 'root', maxTokens: 50, maxSteps: 4 });
  store.createJob({ jobId: 'child-a', rootJobId: 'root', parentJobId: 'root', maxTokens: 40, maxSteps: 3 });

  const generation = store.beginGeneration('child-a');
  const first = store.recordAssistantUsage('child-a', generation, { inputTokens: 10, outputTokens: 5 });
  assert.equal(first.mayExecuteTools, true);
  assert.equal(first.root.inputTokens + first.root.outputTokens, 15);
  assert.equal(store.finishGeneration('child-a', generation), true);

  const reopened = fixture.reopen();
  assert.deepEqual(reopened.canStartGeneration('child-a'), { allowed: true, reasons: [] });
  const secondGeneration = reopened.beginGeneration('child-a');
  const second = reopened.recordAssistantUsage('child-a', secondGeneration, { inputTokens: 20, outputTokens: 10 });
  assert.equal(second.mayExecuteTools, false, 'job ceiling blocks tools after the actual response crosses it');
  assert.deepEqual(second.reasons, ['job_token_budget']);
  assert.equal(reopened.readJob('child-a').status, 'budget_exceeded');
  assert.equal(reopened.canStartGeneration('child-a').allowed, false);
});

test('children share the durable root token and step budgets', (t) => {
  const { store } = temporaryStore(t);
  store.createJob({ jobId: 'root', maxTokens: 30, maxSteps: 3 });
  store.createJob({ jobId: 'child-a', rootJobId: 'root', parentJobId: 'root', maxTokens: 100, maxSteps: 10 });
  store.createJob({ jobId: 'child-b', rootJobId: 'root', parentJobId: 'root', maxTokens: 100, maxSteps: 10 });

  const first = store.beginGeneration('child-a');
  store.recordAssistantUsage('child-a', first, { inputTokens: 8, outputTokens: 7 });
  store.finishGeneration('child-a', first);
  const second = store.beginGeneration('child-b');
  const overRootBudget = store.recordAssistantUsage('child-b', second, { inputTokens: 10, outputTokens: 10 });
  assert.equal(overRootBudget.mayExecuteTools, false);
  assert.deepEqual(overRootBudget.reasons, ['root_token_budget']);
  assert.equal(overRootBudget.root.inputTokens + overRootBudget.root.outputTokens, 35);
});

test('step ceiling allows the last response but prevents another model generation', (t) => {
  const { store } = temporaryStore(t);
  store.createJob({ jobId: 'root', maxTokens: 1000, maxSteps: 1 });
  const generation = store.beginGeneration('root');
  const result = store.recordAssistantUsage('root', generation, { inputTokens: 1, outputTokens: 2 });
  assert.equal(result.mayExecuteTools, true);
  assert.equal(result.mayStartNextGeneration, false);
  assert.equal(store.finishGeneration('root', generation), true);
  assert.deepEqual(store.canStartGeneration('root'), { allowed: false, reasons: ['job_step_budget', 'root_step_budget'] });
  assert.throws(() => store.beginGeneration('root'), RuntimeStateError);
});

test('parent child wait and result survive a SQLite restart', (t) => {
  const fixture = temporaryStore(t);
  fixture.store.createJob({ jobId: 'root', maxTokens: 1000, maxSteps: 10 });
  fixture.store.createJob({ jobId: 'child', rootJobId: 'root', parentJobId: 'root', maxTokens: 500, maxSteps: 5 });
  const generation = fixture.store.beginGeneration('root');
  fixture.store.recordAssistantUsage('root', generation, { inputTokens: 1, outputTokens: 1 });
  fixture.store.waitForChild('root', 'child');

  const reopened = fixture.reopen();
  assert.equal(reopened.readJob('root').status, 'waiting_children');
  assert.equal(reopened.readJob('root').waitingChildId, 'child');
  assert.equal(reopened.resolveChildWait('root', { jobId: 'different-child', outcome: 'succeeded' }), false);
  assert.equal(reopened.resolveChildWait('root', { jobId: 'child', outcome: 'succeeded', summary: 'passed' }), true);

  const afterResult = fixture.reopen().readJob('root');
  assert.equal(afterResult.status, 'ready');
  assert.equal(afterResult.waitingChildId, null);
  assert.deepEqual(afterResult.childResult, { jobId: 'child', outcome: 'succeeded', summary: 'passed' });
  assert.equal(fixture.store.beginGeneration('root'), generation + 1);
});

test('stale and duplicate usage writes are rejected', (t) => {
  const { store } = temporaryStore(t);
  store.createJob({ jobId: 'root', maxTokens: 100, maxSteps: 3 });
  const generation = store.beginGeneration('root');
  store.recordAssistantUsage('root', generation, { inputTokens: 2, outputTokens: 1 });
  assert.throws(() => store.recordAssistantUsage('root', generation, { inputTokens: 2, outputTokens: 1 }), /already recorded/);
  assert.throws(() => store.recordAssistantUsage('root', generation - 1, { inputTokens: 2, outputTokens: 1 }), /stale generation/);
});
