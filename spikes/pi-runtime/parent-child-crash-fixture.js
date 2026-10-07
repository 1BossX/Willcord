import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { coordinatorFixture } from './coordinator-test-support.js';
const [root, mode] = process.argv.slice(2);
const f = await coordinatorFixture(root);
f.coordinator.createJob({ jobId: 'parent', role: 'main', maxTokens: 100000, maxSteps: 10, prompt: 'delegate original work' });
const parent = createFauxCore({ provider: 'crash', api: 'crash', models: [{ id: 'test' }] });
parent.setResponses([fauxAssistantMessage([fauxToolCall('delegate', { input: 'one' }, { id: 'delegate-one' }), fauxToolCall('delegate', { input: 'two' }, { id: 'delegate-two' })], { stopReason: 'toolUse' })]);
if (mode === 'accepted') {
  const original = f.store.recordResult.bind(f.store);
  f.store.recordResult = (...args) => { const result = original(...args); queueMicrotask(() => process.kill(process.pid, 'SIGKILL')); return result; };
}
await f.coordinator.runStep('parent', parent.streamSimple);
if (mode === 'cancel_accepted') {
  const transaction = f.store.db.transaction.bind(f.store.db);
  f.store.db.transaction = (fn) => {
    const original = transaction(fn);
    const wrapped = (...args) => original(...args);
    wrapped.immediate = (...args) => {
      const value = original.immediate(...args);
      if (f.coordinator.readJob('parent').cancelRequested) process.kill(process.pid, 'SIGKILL');
      return value;
    };
    return wrapped;
  };
  await f.coordinator.cancel('parent');
}
if (mode === 'child_model') await f.coordinator.runStep(f.coordinator.children('parent')[0].jobId, () => { process.kill(process.pid, 'SIGKILL'); });
for (const child of f.coordinator.children('parent')) {
  const c = createFauxCore({ provider: 'child', api: 'child', models: [{ id: 'test' }] }); c.setResponses([fauxAssistantMessage(`original result:${child.jobId}`)]);
  await f.coordinator.runStep(child.jobId, c.streamSimple);
}
if (mode === 'child_completed') process.kill(process.pid, 'SIGKILL');
if (mode === 'projection' || mode === 'projection_mid') {
  const original = f.store.appendHistory.bind(f.store);
  f.store.appendHistory = (...args) => { const result = original(...args); if (args[1].startsWith('child-result:') && mode === 'projection_mid') process.kill(process.pid, 'SIGKILL'); if (args[1].startsWith('child-result:')) queueMicrotask(() => process.kill(process.pid, 'SIGKILL')); return result; };
  f.coordinator.scanChildren('parent');
}
throw new Error('crash window not reached');
