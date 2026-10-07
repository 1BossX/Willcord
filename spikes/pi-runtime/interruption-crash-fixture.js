import { coordinatorFixture } from './coordinator-test-support.js';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
const [root] = process.argv.slice(2);
const f = await coordinatorFixture(root);
f.coordinator.createJob({ jobId: 'job', maxTokens: 100000, maxSteps: 10, prompt: 'original request' });
const prepare = f.store.db.prepare.bind(f.store.db);
f.store.db.prepare = (sql) => {
  const statement = prepare(sql);
  if (!sql.includes('INSERT INTO coordinator_drafts')) return statement;
  return { run(...args) {
    const result = statement.run(...args);
    if (args[2].includes('draft-old-call')) process.kill(process.pid, 'SIGKILL');
    return result;
  } };
};
await f.coordinator.runStep('job', () => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial = fauxAssistantMessage([{ type: 'text', text: 'old uncommitted draft' }, fauxToolCall('write', { input: 'discard' }, { id: 'draft-old-call' })], { stopReason: 'toolUse' });
    stream.push({ type: 'start', partial });
    stream.push({ type: 'toolcall_delta', contentIndex: 1, delta: '{}', partial });
  });
  return stream;
});
throw new Error('draft crash window not reached');
