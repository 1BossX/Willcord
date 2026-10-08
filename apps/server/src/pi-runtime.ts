// @ts-nocheck
import { createHash } from 'node:crypto';
import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

export const ROLE_TOOLS = Object.freeze({ main: Object.freeze(['list_workers','delegate','get_job']), worker: Object.freeze(['read','write','bash']) });
export async function createPiSession({role,cwd,agentDir,sessionDir,sessionManager,model,modelRuntime,customTools,commitAssistantTurn,onAssistantTurn}) {
 const allowlist=ROLE_TOOLS[role]; if(!allowlist) throw new Error(`unknown agent role: ${role}`);
 if(typeof commitAssistantTurn!=='function') throw new TypeError('commitAssistantTurn is required');
 const registered=customTools.map(t=>t.name).sort(),allowed=[...allowlist].sort();
 if(JSON.stringify(registered)!==JSON.stringify(allowed)) throw new Error(`custom tools must exactly match ${role} allowlist`);
 const manager=sessionManager??SessionManager.create(cwd,sessionDir);
 const {session}=await createAgentSession({cwd,agentDir,sessionManager:manager,model,modelRuntime,noTools:'all',tools:[...allowlist],customTools});
 session.setAutoCompactionEnabled(false);
 if(JSON.stringify([...session.getActiveToolNames()].sort())!==JSON.stringify(allowed)){session.dispose();throw new Error('Pi activated unexpected tools');}
 session.agent.toolExecution='sequential';
 const finish=session.agent.finishTurn;
 session.agent.finishTurn=async(turn,signal)=>{const decision=await finish?.(turn,signal);await onAssistantTurn?.({message:structuredClone(turn.message),toolResults:structuredClone(turn.toolResults),signal});return decision?.action==='end'?decision:{action:'end'};};
 const before=session.agent.beforeToolCall;
 session.agent.beforeToolCall=async(context,signal)=>{const message=structuredClone(context.assistantMessage);const calls=message.content.filter(block=>block.type==='toolCall');if(!calls.length)throw new Error('Pi hook omitted tool calls');const key=message.responseId?`response:${message.responseId}`:`sha256:${createHash('sha256').update(JSON.stringify(message)).digest('hex')}`;const committed=await commitAssistantTurn({turnKey:key,assistantMessage:message,calls,currentCallId:context.toolCall.id,currentArguments:structuredClone(context.args),signal});if(committed===false)return {block:true,reason:'assistant tool batch rejected by host',terminate:true};return before?.(context,signal);};
 return {session,sessionManager:manager};
}
