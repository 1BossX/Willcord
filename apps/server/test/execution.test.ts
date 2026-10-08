import {test} from "node:test";
import assert from "node:assert/strict";
import {requestHash, MAX_FRAME_BYTES} from "@worker-plane/protocol";
import {openDatabase} from "../src/storage.js";
import {ExecutionCoordinator} from "../src/execution.js";

function fixture(){
 const db=openDatabase(":memory:");
 db.prepare("INSERT INTO workers VALUES('venus','boot','ledger',2,1,1,0,?)").run(Date.now());
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
