import {test} from "node:test";
import assert from "node:assert/strict";
import {requestHash, MAX_FRAME_BYTES} from "@worker-plane/protocol";
import {openDatabase} from "../src/storage.js";
import {ExecutionCoordinator} from "../src/execution.js";

function fixture(){
 const db=openDatabase(":memory:");
 db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('venus','boot','ledger',2,1,1,0,?)").run(Date.now());
 db.prepare("INSERT INTO worker_slots(worker_id) VALUES('venus')").run();
 db.prepare("INSERT INTO workspaces VALUES('venus','primary',1,'/tmp','github.com/acme/repo',1)").run();
 db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path) VALUES('s','worker','venus','primary',1,'github.com/acme/repo','/tmp')").run();
 db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at) VALUES('j','s','r','h','run','venus',1,'running',?)").run(Date.now());
 db.prepare("UPDATE worker_slots SET active_job_id='j'").run();
 const sent:any[]=[];const socket={readyState:1,send:(v:string)=>sent.push(JSON.parse(v))};
 const connections=new Map([["venus",{epoch:2,socket,tokenDigest:"token"}]]);
 // The job is held by a live run elsewhere; these tests drive calls directly.
 const coordinator=new ExecutionCoordinator(db,connections,Date.now,()=>new Promise(()=>{}));
 /** Commit an intent the way Pi's beforeToolCall hook does. */
 const commit=(callId:string,seq:number,tool:string,args:object)=>{
  const hash=requestHash({worker_id:"venus",job_id:"j",call_id:callId,call_seq:seq,workspace_id:"primary",config_version:1,tool,arguments:args});
  db.prepare("INSERT INTO runtime_turns VALUES('j',?,'{}','h',?)").run(`turn-${callId}`,Date.now());
  db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('j',?,?,?,?,?,?,'committed')").run(`turn-${callId}`,callId,seq,hash,tool,JSON.stringify(args));
  return hash;
 };
 const result=(callId:string,hash:string,result:object,ok=true)=>coordinator.receive({protocol_version:1,type:"tool_result",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:callId,request_hash:hash,ok,result});
 const one=(sql:string)=>db.prepare(sql).get() as any;
 return {db,sent,socket,connections,coordinator,commit,result,one};
}

test("P2 dispatch binds a persisted intent, commits a matching result, then ACKs it",async()=>{
 const {db,sent,coordinator,commit,result,one}=fixture();
 const args={path:"README.md",offset:0,limit:20};
 const digest=commit("c",1,"read",args);
 const dispatched=coordinator.dispatch("j","c");
 assert.equal(sent[0].type,"tool_call");assert.equal(sent[0].request_hash,digest);assert.equal(sent[0].call_id,"c");
 result("c",digest,{text:"fixture"});
 assert.deepEqual(await dispatched,{ok:true,result:{text:"fixture"}});assert.equal(sent[1].type,"tool_ack");assert.equal(sent[1].ack_through,1);
 assert.equal(one("SELECT state FROM tool_calls WHERE call_id='c'").state,"finished");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c'").status,"completed");
 assert.equal(one("SELECT count(*) n FROM messages WHERE job_id='j'").n,1);
 const content="worker-plane-large-write/".repeat(5000),writeArgs={path:"large.txt",content,expected_hash:"missing"};
 const writeHash=commit("w",2,"write",writeArgs);
 const large=coordinator.dispatch("j","w");
 const frames=sent.slice(2);assert.equal(frames[0].type,"tool_call");assert.equal(frames[0].arguments.transfer_bytes,Buffer.byteLength(content));
 const payload=Buffer.concat(frames.slice(1).map((f:any)=>Buffer.from(f.data,"base64"))).toString("utf8");assert.equal(payload,content);assert.ok(frames.every((f:any)=>Buffer.byteLength(JSON.stringify(f))<=MAX_FRAME_BYTES));assert.equal(frames.at(-1).final,true);
 result("w",writeHash,{bytes:content.length});
 assert.deepEqual(await large,{ok:true,result:{bytes:content.length}});
 coordinator.close();db.close();
});

test("P3 a ledger rejection marks the call unknown and blocks instead of retrying",async()=>{
 const {db,sent,coordinator,commit,one}=fixture();
 const hash=commit("c1",1,"bash",{command:"true"});
 const call=coordinator.dispatch("j","c1");
 coordinator.receive({protocol_version:1,type:"tool_rejected",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:hash,reason:"unknown"});
 await assert.rejects(call,/tool_rejected:unknown/);
 assert.equal(sent.length,1,"a rejected call is never re-sent");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c1'").status,"unknown");
 assert.equal(one("SELECT state FROM jobs WHERE job_id='j'").state,"needs_attention");
 assert.equal(one("SELECT blocked FROM workers WHERE worker_id='venus'").blocked,1);
 assert.match(one("SELECT evidence FROM attention_actions").evidence,/tool_rejected:unknown/);
 await assert.rejects(coordinator.dispatch("j","c1"),/call_unknown/);
 coordinator.close();db.close();
});

test("P3 a call waits through disconnection and is re-sent unchanged after reconciliation",async()=>{
 const {db,sent,socket,coordinator,commit,result,one}=fixture();
 const hash=commit("c1",1,"bash",{command:"echo once >> marker"});
 socket.readyState=3;
 const call=coordinator.dispatch("j","c1");
 assert.equal(sent.length,0,"nothing is sent to a closed connection");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c1'").status,"dispatched");
 socket.readyState=1;db.prepare("UPDATE workers SET reconciled=0").run();
 coordinator.resumeWorker("venus");
 assert.equal(sent.length,0,"an unreconciled connection carries no calls");
 db.prepare("UPDATE workers SET reconciled=1").run();
 coordinator.resumeWorker("venus");
 assert.equal(sent.length,1);assert.equal(sent[0].request_hash,hash);
 coordinator.resumeWorker("venus");
 assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0],"redelivery repeats the identical request");
 result("c1",hash,{exit_code:0});
 assert.deepEqual(await call,{ok:true,result:{exit_code:0}});
 // A duplicate result is acknowledged again but committed once.
 result("c1",hash,{exit_code:0});
 assert.equal(sent.filter(f=>f.type==="tool_ack").length,2);
 assert.equal(one("SELECT count(*) n FROM messages").n,1);
 result("c1",hash,{exit_code:1});
 assert.equal(one("SELECT blocked FROM workers").blocked,1,"a different result for a committed call is a contradiction");
 coordinator.close();db.close();
});

test("P3 reconciliation re-ACKs settled calls and blocks on anything it cannot explain",async()=>{
 const report=(callId:string,seq:number,hash:string,status:string,boot="boot")=>({job_id:"j",call_id:callId,call_seq:seq,request_hash:hash,status,boot_id:boot});
 {
  const {db,sent,coordinator,commit,result,one}=fixture();
  const h1=commit("c1",1,"bash",{command:"a"}),h2=commit("c2",2,"bash",{command:"b"});
  coordinator.dispatch("j","c1");result("c1",h1,{exit_code:0});
  coordinator.dispatch("j","c2").catch(()=>{});
  const reacks=coordinator.reconcile("venus",[report("c1",1,h1,"completed"),report("c2",2,h2,"running")]);
  assert.deepEqual(reacks.map(r=>r.call_id),["c1"]);
  assert.equal(one("SELECT blocked FROM workers").blocked,0,"a running call of the same boot is observed, not blocked");
  sent.length=0;coordinator.resumeWorker("venus",reacks);
  assert.deepEqual(sent.map(f=>[f.type,f.call_id]),[["tool_ack","c1"],["tool_call","c2"]]);
  db.close();
 }
 const blockedBy=(setup:(f:ReturnType<typeof fixture>)=>any[],reason:RegExp)=>{
  const f=fixture();
  f.coordinator.reconcile("venus",setup(f));
  assert.equal(f.one("SELECT blocked FROM workers").blocked,1);
  assert.match(f.one("SELECT evidence FROM attention_actions").evidence,reason);
  f.coordinator.close();f.db.close();
 };
 blockedBy(({commit,coordinator})=>{const h=commit("c1",1,"bash",{command:"a"});coordinator.dispatch("j","c1").catch(()=>{});return [report("c1",1,h,"unknown")];},/worker_reports_unknown_execution/);
 blockedBy(({commit,coordinator})=>{const h=commit("c1",1,"bash",{command:"a"});coordinator.dispatch("j","c1").catch(()=>{});return [report("c1",1,h,"running","old-boot")];},/in_flight_contradiction/);
 blockedBy(({commit})=>{commit("c1",1,"bash",{command:"a"});return [report("c1",1,"f".repeat(64),"completed")];},/ledger_contradiction/);
 blockedBy(({commit})=>{const h=commit("c1",1,"bash",{command:"a"});return [report("c1",1,h,"running")];},/ledger_reports_committed_call/);
 blockedBy(()=>[report("ghost",1,"a".repeat(64),"completed")],/ledger_contradiction/);
 blockedBy(()=>[{...report("legacy",0,"a".repeat(64),"unknown"),job_id:"p2-job"}],/worker_reports_unknown_execution/);
 blockedBy(({db})=>{db.prepare("UPDATE worker_slots SET active_job_id='missing'").run();return [];},/slot_held_by_unknown_job/);
});

test("P3 a run that ends with an unresolved call keeps the slot and needs attention",async()=>{
 const {db,connections,commit,one}=fixture();
 commit("c1",1,"bash",{command:"a"});
 db.prepare("UPDATE worker_slots SET active_job_id=NULL").run();db.prepare("UPDATE jobs SET state='queued'").run();
 const coordinator=new ExecutionCoordinator(db,connections,Date.now,async(job:any)=>{coordinator.dispatch(job.job_id,"c1").catch(()=>{});throw new Error("model crashed");});
 await coordinator.pump("venus");
 assert.equal(one("SELECT state FROM jobs").state,"needs_attention");
 assert.equal(one("SELECT active_job_id FROM worker_slots").active_job_id,"j");
 assert.equal(one("SELECT blocked FROM workers").blocked,1);
 coordinator.close();db.close();
});

test("a run that dies on the model call records why instead of 'unknown'",async()=>{
 for(const [message,reason] of [['model_error: 401: {"message":"Missing Authentication header","code":401}',"model_auth_failed"],["model_error: 429: rate limited","model_error"],["model_not_configured: no model API key","model_not_configured"],["boom",null]] as const){
  const {db,connections,one}=fixture();
  db.prepare("UPDATE worker_slots SET active_job_id=NULL").run();db.prepare("UPDATE jobs SET state='queued'").run();
  const coordinator=new ExecutionCoordinator(db,connections,Date.now,async()=>{throw new Error(message);});
  const log=console.error;console.error=()=>{};
  try{await coordinator.pump("venus");}finally{console.error=log;}
  assert.deepEqual(one("SELECT state,end_reason FROM jobs"),{state:"failed",end_reason:reason},message);
  coordinator.close();db.close();
 }
});

test("P3 a committed request that no longer rebuilds blocks the worker without closing its connection",async()=>{
 const {db,sent,coordinator,commit,one}=fixture();
 commit("c1",1,"bash",{command:"echo once"});
 db.prepare("UPDATE runtime_calls SET arguments_json=? WHERE call_id='c1'").run(JSON.stringify({command:"echo tampered"}));
 await assert.rejects(coordinator.dispatch("j","c1"),/committed_request_unrebuildable/);
 assert.doesNotThrow(()=>coordinator.resumeWorker("venus"));
 assert.equal(sent.length,0,"nothing is sent for a request that does not match its commit");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c1'").status,"unknown");
 assert.equal(one("SELECT state FROM jobs").state,"needs_attention");
 assert.equal(one("SELECT blocked FROM workers").blocked,1);
 assert.match(one("SELECT evidence FROM attention_actions").evidence,/committed_request_unrebuildable/);
 coordinator.close();db.close();
});

test("P3 an inference from a superseded run commits neither a tool turn nor a final answer",async()=>{
 const {db,coordinator,one}=fixture();
 db.prepare("UPDATE jobs SET runtime_generation=2").run();
 const stale={job_id:"j",session_id:"s",worker_id:"venus",workspace_id:"primary",workspace_version:1,runtime_generation:1};
 const call={id:"late",name:"bash",arguments:{command:"echo late"}};
 const turn=(coordinator as any).commitTurn(stale,"turn-late",{role:"assistant",content:[{type:"toolCall",...call}]},[call]);
 const final=(coordinator as any).commitFinal(stale,{role:"assistant",content:[{type:"text",text:"late answer"}]});
 assert.equal(turn,false);assert.equal(final,false);
 assert.equal(one("SELECT count(*) n FROM runtime_turns").n,0);
 assert.equal(one("SELECT count(*) n FROM runtime_calls").n,0);
 assert.equal(one("SELECT count(*) n FROM messages").n,0);
 assert.equal(one("SELECT state FROM jobs").state,"running");
 coordinator.close();db.close();
});

test("P4 a refusal that proves non-execution records the call as not executed and does not block",async()=>{
 const {db,sent,coordinator,commit,one}=fixture();
 const hash=commit("c1",1,"bash",{command:"true",timeout_secs:900});
 const call=coordinator.dispatch("j","c1");
 coordinator.receive({protocol_version:1,type:"tool_rejected",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:hash,reason:"disk_full"});
 assert.deepEqual(await call,{ok:false,result:{error:"not_executed:disk_full",not_executed:true,reason:"disk_full"}});
 assert.equal(sent.length,1,"no ACK: the worker recorded nothing");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c1'").status,"not_executed");
 assert.equal(one("SELECT blocked FROM workers").blocked,0);
 // A full disk proves nothing ran, but the job cannot go on: it fails, the worker stays usable.
 assert.deepEqual(one("SELECT state,end_reason FROM jobs"),{state:"failed",end_reason:"worker_disk_full"});
 coordinator.close();db.close();
});

test("P4 cancel of a running job stops new work, keeps the slot until the sent call ends, keeps its real result",async()=>{
 const {db,sent,coordinator,commit,result,one}=fixture();
 const h1=commit("c1",1,"bash",{command:"sleep 60"});
 commit("c2",2,"bash",{command:"echo never"});
 const first=coordinator.dispatch("j","c1");
 const generation=one("SELECT runtime_generation g FROM jobs").g;
 assert.equal(coordinator.cancel("j"),"cancel_requested");
 assert.equal(one("SELECT runtime_generation g FROM jobs").g,generation+1,"a superseded run commits nothing more");
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c2'").status,"not_executed","never sent, so proven not run");
 const cancel=sent.find((f)=>f.type==="cancel_call");
 assert.deepEqual([cancel.call_id,cancel.call_seq,cancel.request_hash],["c1",1,h1]);
 assert.equal(coordinator.cancel("j"),"cancel_requested","repeat cancel is idempotent");
 assert.equal(sent.filter((f)=>f.type==="cancel_call").length,2,"repeat re-sends the idempotent stop");
 coordinator.receive({protocol_version:1,type:"cancel_ack",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:h1,state:"running"});
 assert.equal(one("SELECT state FROM jobs").state,"cancel_requested","a receipt is not proof of stop");
 assert.equal(one("SELECT active_job_id a FROM worker_slots").a,"j");
 result("c1",h1,{exit_code:null,termination:"cancelled",signal:15},false);
 assert.equal((await first).ok,false);
 assert.equal(one("SELECT status FROM runtime_calls WHERE call_id='c1'").status,"completed","the real result is kept");
 assert.deepEqual(one("SELECT state,end_reason FROM jobs"),{state:"cancelled",end_reason:"cancelled_by_user"});
 assert.equal(one("SELECT active_job_id a FROM worker_slots").a,null);
 assert.equal(coordinator.cancel("j"),"cancelled","a terminal job keeps its state");
 coordinator.close();db.close();
});

test("P4 a fenced cancel proves the call never ran; an offline cancel is sent first on reconnect",async()=>{
 const {db,sent,connections,coordinator,commit,one}=fixture();
 const h1=commit("c1",1,"read",{path:"a"});
 const pending=coordinator.dispatch("j","c1");
 sent.length=0;
 connections.delete("venus");
 coordinator.cancel("j");
 assert.equal(sent.length,0,"offline: the request is kept, not lost");
 assert.equal(one("SELECT state FROM jobs").state,"cancel_requested");
 connections.set("venus",{epoch:2,socket:{readyState:1,send:(v:string)=>sent.push(JSON.parse(v))},tokenDigest:"token"});
 coordinator.resumeWorker("venus");
 assert.equal(sent[0].type,"cancel_call","the stop precedes anything else");
 assert.ok(!sent.some((f)=>f.type==="tool_call"),"a cancelled call is never re-sent");
 coordinator.receive({protocol_version:1,type:"cancel_ack",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:h1,state:"fenced"});
 assert.equal((await pending).result.reason,"cancelled");
 assert.equal(one("SELECT status FROM runtime_calls").status,"not_executed");
 assert.equal(one("SELECT state FROM jobs").state,"cancelled");
 coordinator.close();db.close();
});

test("P4 queued cancel creates no call; cancel of a job needing attention is only recorded",async()=>{
 const {db,coordinator,one}=fixture();
 db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at) VALUES('q','s','r2','h','run','venus',2,'queued',?)").run(Date.now());
 assert.equal(coordinator.cancel("q"),"cancelled");
 assert.equal(one("SELECT count(*) n FROM runtime_calls WHERE job_id='q'").n,0);
 db.prepare("UPDATE jobs SET state='needs_attention' WHERE job_id='j'").run();
 assert.equal(coordinator.cancel("j"),"needs_attention");
 assert.deepEqual(one("SELECT state,cancel_requested FROM jobs WHERE job_id='j'"),{state:"needs_attention",cancel_requested:1});
 assert.equal(coordinator.cancel("missing"),undefined);
 coordinator.close();db.close();
});

test("P4 abandon keeps the block; unblock needs evidence for every unknown call and the worker's confirmation",async()=>{
 const {db,sent,coordinator,commit,one}=fixture();
 const h1=commit("c1",1,"bash",{command:"x"});
 const pending=coordinator.dispatch("j","c1");pending.catch(()=>{});
 coordinator.receive({protocol_version:1,type:"tool_rejected",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:h1,reason:"unknown"});
 assert.equal(one("SELECT state FROM jobs").state,"needs_attention");
 assert.equal(coordinator.unblock("venus","checked",[{call_id:"c1",outcome:"terminated"}]).hasOwnProperty("error"),true,"the job must be abandoned or settled first");
 assert.deepEqual(coordinator.abandon("j","giving up"),{state:"cancelled"});
 assert.equal(one("SELECT end_reason FROM jobs").end_reason,"abandoned");
 assert.equal(one("SELECT blocked FROM workers").blocked,1,"abandon never unblocks");
 assert.equal(one("SELECT active_job_id a FROM worker_slots").a,"j","the unknown call keeps the slot");
 assert.deepEqual(coordinator.unblock("venus","checked",[]),{error:"resolutions_must_cover_unknown_calls"});
 sent.length=0;
 assert.deepEqual(coordinator.unblock("venus","ps shows no process; marker absent",[{call_id:"c1",outcome:"not_executed"}]),{blocked:1,unblock_pending:1});
 const resolve=sent.find((f)=>f.type==="resolve_call");
 assert.deepEqual([resolve.call_id,resolve.call_seq,resolve.request_hash],["c1",1,h1]);
 assert.equal(one("SELECT status FROM runtime_calls").status,"resolved");
 coordinator.receive({protocol_version:1,type:"resolve_ack",worker_id:"venus",connection_epoch:2,job_id:"j",call_id:"c1",request_hash:h1,state:"resolved"});
 assert.deepEqual(one("SELECT blocked,unblock_pending FROM workers"),{blocked:0,unblock_pending:0});
 assert.equal(one("SELECT active_job_id a FROM worker_slots").a,null);
 const actions=db.prepare("SELECT action,evidence FROM attention_actions ORDER BY created_at,rowid").all() as any[];
 assert.deepEqual(actions.map((a)=>a.action),["blocked","abandon","unblock","unblocked"]);
 assert.match(actions[2].evidence,/marker absent/);
 coordinator.close();db.close();
});

test("P4 a turn over the tool-call budget is committed but none of its calls is sent",async()=>{
 const {db,sent,coordinator,one}=fixture();
 db.prepare("UPDATE jobs SET root_job_id='j',max_tool_calls=1").run();
 db.prepare("INSERT INTO budget_roots(root_job_id) VALUES('j')").run();
 const job={...one("SELECT j.*,s.workspace_id,s.workspace_version FROM jobs j JOIN sessions s USING(session_id)")};
 const call=(id:string)=>({type:"toolCall",id,name:"read",arguments:{path:id}});
 const turn=(key:string,ids:string[])=>(coordinator as any).commitTurn(job,key,{role:"assistant",content:ids.map(call),usage:{input:10,output:5}},ids.map(call));
 assert.equal(turn("t1",["a"]),true);
 job.runtime_generation=one("SELECT runtime_generation g FROM jobs").g;
 assert.equal(turn("t2",["b","c"]),false);
 assert.deepEqual(db.prepare("SELECT call_id,status FROM runtime_calls ORDER BY call_seq").all(),[{call_id:"a",status:"not_executed"},{call_id:"b",status:"not_executed"},{call_id:"c",status:"not_executed"}]);
 assert.deepEqual(one("SELECT tokens_used,tool_calls_used FROM budget_roots"),{tokens_used:30,tool_calls_used:3});
 assert.deepEqual(one("SELECT state,cancel_reason FROM jobs"),{state:"failed",cancel_reason:"budget_tool_calls"});
 assert.equal(sent.length,0);
 coordinator.close();db.close();
});

test("P4 a resolved call the worker later reports as completed is ACKed, not a new contradiction",async()=>{
 const {db,sent,coordinator,commit,result,one}=fixture();
 const h1=commit("c1",1,"bash",{command:"x"});
 db.prepare("UPDATE runtime_calls SET status='resolved',result_json='{}',resolve_acked=0").run();
 db.prepare("UPDATE workers SET blocked=1,unblock_pending=1").run();
 const reacks=coordinator.reconcile("venus",[{job_id:"j",call_id:"c1",call_seq:1,request_hash:h1,status:"completed",boot_id:"boot"}]);
 assert.deepEqual(reacks.map((r)=>r.call_id),["c1"]);
 result("c1",h1,{exit_code:0});
 assert.equal(sent.at(-1).type,"tool_ack");
 assert.equal(one("SELECT status FROM runtime_calls").status,"resolved");
 assert.deepEqual(one("SELECT unblock_pending,(SELECT count(*) FROM attention_actions) n FROM workers"),{unblock_pending:1,n:0});
 coordinator.close();db.close();
});
