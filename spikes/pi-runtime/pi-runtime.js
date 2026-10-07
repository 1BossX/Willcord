import { createHash } from 'node:crypto';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

export const ROLE_TOOLS = Object.freeze({
  main: Object.freeze(['list_workers', 'delegate', 'get_job']),
  worker: Object.freeze(['read', 'write', 'bash']),
});

/**
 * Create a Pi session with a closed tool allowlist and a durable pre-execution seam.
 *
 * `commitAssistantTurn` must commit the complete assistant message and every tool
 * intent in one transaction. Pi invokes `beforeToolCall` with the whole assistant
 * message before executing each tool. Repeated calls for the same message must be
 * idempotent in the host implementation.
 */
export async function createPiSession({
  role,
  cwd,
  agentDir,
  sessionDir,
  sessionManager,
  model,
  modelRuntime,
  customTools,
  commitAssistantTurn,
  onAssistantTurn,
}) {
  const allowlist = ROLE_TOOLS[role];
  if (!allowlist) throw new Error(`unknown agent role: ${role}`);
  if (typeof commitAssistantTurn !== 'function') {
    throw new TypeError('commitAssistantTurn is required');
  }

  const registeredNames = customTools.map((tool) => tool.name).sort();
  const allowedNames = [...allowlist].sort();
  if (JSON.stringify(registeredNames) !== JSON.stringify(allowedNames)) {
    throw new Error(`custom tools must exactly match the ${role} allowlist`);
  }

  const manager = sessionManager ?? SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: manager,
    model,
    modelRuntime,
    noTools: 'all',
    tools: [...allowlist],
    customTools,
  });

  const activeNames = [...session.getActiveToolNames()].sort();
  if (JSON.stringify(activeNames) !== JSON.stringify(allowedNames)) {
    session.dispose();
    throw new Error(`Pi activated unexpected tools: ${activeNames.join(', ')}`);
  }

  // Be explicit: no single model response may execute calls concurrently.
  session.agent.toolExecution = 'sequential';
  const previousFinishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    const previousDecision = await previousFinishTurn?.(turn, signal);
    await onAssistantTurn?.({
      message: structuredClone(turn.message),
      toolResults: structuredClone(turn.toolResults),
      signal,
    });
    // The host owns budgets, durable waits, and when another model turn begins.
    // Pi must settle after one completed assistant response so the host can commit
    // results/checkpoints before explicitly calling continue().
    return previousDecision?.action === 'end' ? previousDecision : { action: 'end' };
  };
  const previousBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    const assistantMessage = structuredClone(context.assistantMessage);
    const calls = assistantMessage.content.filter((block) => block.type === 'toolCall');
    if (calls.length === 0) throw new Error('Pi tool hook did not include its assistant tool calls');
    const turnKey = assistantMessage.responseId
      ? `response:${assistantMessage.responseId}`
      : `sha256:${createHash('sha256').update(JSON.stringify(assistantMessage)).digest('hex')}`;

    const committed = await commitAssistantTurn({
      turnKey,
      assistantMessage,
      calls,
      currentCallId: context.toolCall.id,
      currentArguments: structuredClone(context.args),
      signal,
    });
    if (committed === false) {
      return { block: true, reason: 'assistant tool batch rejected by host', terminate: true };
    }
    return previousBeforeToolCall?.(context, signal);
  };

  return { session, sessionManager: manager };
}
