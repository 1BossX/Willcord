import { SessionManager } from '@earendil-works/pi-coding-agent';
import { isDeepStrictEqual } from 'node:util';

export class RecoveryBlockedError extends Error {
  constructor(calls, reason = 'unresolved durable tool calls') {
    super(reason);
    this.name = 'RecoveryBlockedError';
    this.calls = calls;
  }
}

/** Build a new Pi projection. Never open an untrusted JSONL branch for execution.
 * The caller must create an AgentSession only after this succeeds. No tools or
 * model are invoked here; pending calls require a separate dispatcher/ledger.
 */
export function recoverTranscript({ store, jobId, cwd, sessionDir }) {
  const history = store.readHistory(jobId);
  const turnCount = store.db.prepare('SELECT COUNT(*) AS count FROM runtime_turns WHERE job_id = ?').get(jobId).count;
  if (history.filter((entry) => entry.turn).length !== turnCount) {
    throw new RecoveryBlockedError([], 'legacy turns require explicit base-history migration');
  }
  if (!history.some((entry) => entry.message?.role === 'user')) {
    throw new RecoveryBlockedError([], 'durable user history is required');
  }
  const pending = history.flatMap((entry) => entry.turn?.calls ?? []).filter((call) => call.status !== 'completed');
  if (pending.length) throw new RecoveryBlockedError(pending);

  const messages = history.flatMap((entry) => {
    if (entry.message) return [entry.message];
    const content = entry.turn.assistantMessage.content;
    if (!Array.isArray(content) || content.some((part) => !part || typeof part !== 'object' || Array.isArray(part))) {
      throw new RecoveryBlockedError([], 'assistant content must be an array of message blocks');
    }
    const intents = content.filter((part) => part.type === 'toolCall');
    if (intents.length !== entry.turn.calls.length || intents.some((intent, i) => {
      const call = entry.turn.calls[i];
      return intent.id !== call.callId || intent.name !== call.name || !isDeepStrictEqual(intent.arguments ?? {}, call.arguments);
    })) throw new RecoveryBlockedError([], 'assistant batch does not match durable calls');
    return [entry.turn.assistantMessage, ...entry.turn.calls.map((call) => {
      const result = call.result;
      if (result?.role !== 'toolResult' || result.toolCallId !== call.callId || result.toolName !== call.name || !Array.isArray(result.content)) {
        throw new RecoveryBlockedError([call], 'result must be a complete Pi toolResult with matching identity');
      }
      return result;
    })];
  });
  // A fresh derived file keeps crash-interrupted rebuilds out of executable
  // history. Repeated recovery always starts from SQLite, never a partial file.
  const manager = SessionManager.create(cwd, sessionDir);
  for (const message of messages) manager.appendMessage(structuredClone(message));
  return { sessionManager: manager, messages };
}
