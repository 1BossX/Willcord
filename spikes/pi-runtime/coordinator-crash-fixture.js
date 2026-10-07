import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFauxCore, fauxAssistantMessage, fauxToolCall, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { coordinatorFixture } from './coordinator-test-support.js';
const [root, mode] = process.argv.slice(2);
const f = await coordinatorFixture(root, { execute: async (request) => {
  appendFileSync(join(root, 'effects.log'), `${request.callId}\n`);
  if (mode === 'effect') process.kill(process.pid, 'SIGKILL');
  return { content: [{ type: 'text', text: 'cached original result' }] };
} });
f.coordinator.createJob({ jobId: 'job', maxTokens: 100000, maxSteps: 10, prompt: 'original request' });
if (mode === 'intent') {
  const original = f.store.persistTurn.bind(f.store);
  f.store.persistTurn = (entry) => { const result = original(entry); queueMicrotask(() => process.kill(process.pid, 'SIGKILL')); return result; };
}
if (mode === 'result') {
  const original = f.ledger.complete.bind(f.ledger);
  f.ledger.complete = (...args) => { original(...args); process.kill(process.pid, 'SIGKILL'); };
}
const c = createFauxCore({ provider: 'crash', api: 'crash', models: [{ id: 'test' }] });
c.setResponses([fauxAssistantMessage([fauxToolCall('write', { input: 'original' }, { id: 'original-call' })], { stopReason: 'toolUse' })]);
await f.coordinator.runStep('job', mode === 'model' ? () => { process.kill(process.pid, 'SIGKILL'); return createAssistantMessageEventStream(); } : c.streamSimple);
throw new Error('crash window was not reached');
