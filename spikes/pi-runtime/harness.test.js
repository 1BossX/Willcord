import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCheckpointStore, RuntimeSeamHarness, StaleGenerationError } from './harness.js';

function setup(executeTool) {
  const store = new InMemoryCheckpointStore();
  store.createJob('job-1');
  return { store, harness: new RuntimeSeamHarness({ store, executeTool }) };
}

test('role tool allowlists reject unsupported tools before checkpoint or execution', async () => {
  let executions = 0;
  const { store, harness } = setup(async () => { executions += 1; });

  await assert.rejects(harness.advance({
    jobId: 'job-1',
    role: 'main',
    model: async () => ({ content: '', toolCalls: [{ id: 'c1', name: 'bash', arguments: {} }] }),
  }), /not allowed/);

  assert.equal(executions, 0);
  assert.equal(store.readJob('job-1').checkpoint, null);
});

test('complete assistant turn and checkpoint are committed before first tool execution', async () => {
  const { store, harness } = setup(async ({ call }) => {
    const job = store.readJob('job-1');
    assert.equal(job.status, 'turn_committed');
    assert.equal(job.messages[0].toolCalls.length, 2);
    assert.deepEqual(job.checkpoint.callIds, ['c1', 'c2']);
    assert.ok(job.checkpoint.calls.some((item) => item.id === call.id));
    return { ok: true };
  });

  const result = await harness.advance({
    jobId: 'job-1',
    role: 'worker',
    model: async () => ({ content: 'checking files', toolCalls: [
      { id: 'c1', name: 'read', arguments: { path: 'a.txt' } },
      { id: 'c2', name: 'bash', arguments: { command: 'true' } },
    ] }),
  });

  assert.equal(result.kind, 'turn_completed');
  assert.equal(store.readJob('job-1').checkpoint.calls.every((call) => call.result.ok), true);
  assert.deepEqual(store.events().map((event) => event.type).slice(0, 2), ['generation_started', 'turn_committed']);
});

test('tool calls from one turn execute serially', async () => {
  let active = 0;
  let maximum = 0;
  const started = [];
  const { harness } = setup(async ({ call }) => {
    if (call.id === 'c2') {
      const firstResult = harness.store.readJob('job-1').checkpoint.calls[0].result;
      assert.deepEqual(firstResult, { id: 'c1' });
    }
    active += 1;
    maximum = Math.max(maximum, active);
    started.push(call.id);
    await new Promise((resolve) => setTimeout(resolve, 8));
    active -= 1;
    return { id: call.id };
  });

  await harness.advance({
    jobId: 'job-1',
    role: 'worker',
    model: async () => ({ toolCalls: [
      { id: 'c1', name: 'read', arguments: {} },
      { id: 'c2', name: 'write', arguments: {} },
      { id: 'c3', name: 'bash', arguments: {} },
    ] }),
  });

  assert.equal(maximum, 1);
  assert.deepEqual(started, ['c1', 'c2', 'c3']);
});

test('late model response from an invalidated generation cannot commit or execute', async () => {
  let release;
  let executions = 0;
  const { store, harness } = setup(async () => { executions += 1; });
  const modelWait = new Promise((resolve) => { release = resolve; });
  const run = harness.advance({
    jobId: 'job-1',
    role: 'worker',
    model: async () => modelWait,
  });

  await new Promise((resolve) => setImmediate(resolve));
  await harness.cancel('job-1');
  release({ toolCalls: [{ id: 'stale', name: 'bash', arguments: {} }] });

  await assert.rejects(run, StaleGenerationError);
  assert.equal(executions, 0);
  assert.equal(store.readJob('job-1').checkpoint, null);
  assert.equal(store.readJob('job-1').status, 'cancelled');
});

test('parent persists waiting state, then resumes only after matching child result', async () => {
  let parentModelCalls = 0;
  const { store, harness } = setup(async ({ call }) => {
    assert.equal(call.name, 'delegate');
    return { kind: 'wait', childJobId: 'child-7' };
  });

  const waiting = await harness.advance({
    jobId: 'job-1',
    role: 'main',
    model: async () => ({ toolCalls: [{ id: 'delegate-1', name: 'delegate', arguments: { task: 'run checks' } }] }),
  });
  assert.deepEqual(waiting, { kind: 'waiting_children', generation: 1, childJobId: 'child-7' });
  assert.equal(store.readJob('job-1').status, 'waiting_children');
  assert.equal(parentModelCalls, 0);

  await assert.rejects(harness.resumeParent({
    jobId: 'job-1',
    childResult: { jobId: 'other-child', outcome: 'succeeded' },
    model: async () => ({ toolCalls: [] }),
  }), /does not match/);

  const resumed = await harness.resumeParent({
    jobId: 'job-1',
    childResult: { jobId: 'child-7', outcome: 'succeeded', summary: 'checks passed' },
    model: async ({ history }) => {
      parentModelCalls += 1;
      assert.equal(history.at(-1).content.summary, 'checks passed');
      return { content: 'done', toolCalls: [] };
    },
  });

  assert.equal(resumed.kind, 'turn_completed');
  assert.equal(parentModelCalls, 1);
  assert.equal(store.readJob('job-1').status, 'ready');
  assert.ok(store.events().some((event) => event.type === 'child_result_committed'));
});
