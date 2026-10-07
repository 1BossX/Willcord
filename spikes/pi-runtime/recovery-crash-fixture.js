import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { SqliteCheckpointStore } from './sqlite-checkpoint.js';

const [root, scenario] = process.argv.slice(2);
const store = new SqliteCheckpointStore(join(root, 'state.sqlite'));
const user = { role: 'user', content: [{ type: 'text', text: 'Original user request' }], timestamp: 1 };
store.appendHistory('job', 'user-1', user);
const manager = SessionManager.create(root, join(root, 'sessions'));
manager.appendMessage(user);
const assistant = fauxAssistantMessage([
  fauxToolCall('read', { input: 'original' }, { id: 'original-1' }),
  fauxToolCall('write', { input: 'second' }, { id: 'original-2' }),
], { stopReason: 'toolUse' });
const calls = assistant.content.filter((part) => part.type === 'toolCall');
if (scenario !== 'jsonl-only') store.persistTurn({ jobId: 'job', turnKey: 'turn', assistantMessage: assistant, calls });
if (scenario !== 'sqlite-only') manager.appendMessage(assistant);
if (['results', 'partial', 'cancelled'].includes(scenario)) {
  const selected = scenario === 'partial' ? calls.slice(0, 1) : calls;
  for (const call of selected) {
    store.markDispatched('job', 'turn', call.id);
    store.recordResult('job', 'turn', call.id, { role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: `result:${call.id}` }], details: { original: true }, isError: false, timestamp: 2 });
  }
}
if (scenario === 'partial') store.markDispatched('job', 'turn', 'original-2');
if (scenario === 'cancelled') store.appendHistory('job', 'cancelled', fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'cancelled' }));
// Deliberately bypass close/dispose: kill an independent process after real
// SQLite and SessionManager writes, leaving the persistence crash window.
process.kill(process.pid, 'SIGKILL');
