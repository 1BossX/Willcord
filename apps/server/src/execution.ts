import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type Database from "better-sqlite3";
import type { WorkerFrame } from "@worker-plane/protocol";
import { requestHash } from "@worker-plane/protocol";

type Socket = { readyState: number; send(data: string): void };
type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const workersInFlight = new Set<string>();

export class ExecutionCoordinator {
  readonly pending = new Map<string, Pending>();
  constructor(readonly db: Database.Database, readonly connections: Map<string, { epoch:number; socket:Socket; tokenDigest:string }>, readonly now=Date.now, readonly runJob?: (job:any)=>Promise<void>) {}

  receive(frame: WorkerFrame) {
    if (frame.type === "tool_result") {
      const pending = this.pending.get(frame.call_id);
      if (!pending) return;
      const call = this.db.prepare("SELECT request_hash,job_id,tool_name,arguments_json FROM runtime_calls WHERE call_id=?").get(frame.call_id) as {request_hash:string;job_id:string;tool_name:string;arguments_json:string}|undefined;
      if (!call || call.request_hash !== frame.request_hash || call.job_id !== frame.job_id) return;
      clearTimeout(pending.timer);
      this.db.transaction(() => {
        this.db.prepare("UPDATE runtime_calls SET status='completed',result_json=? WHERE call_id=? AND status='dispatched'").run(JSON.stringify({ok:frame.ok,result:frame.result}),frame.call_id);
        this.db.prepare("UPDATE tool_calls SET state='finished',result_json=? WHERE call_id=?").run(JSON.stringify({ok:frame.ok,result:frame.result}),frame.call_id);
        const job=this.db.prepare("SELECT session_id FROM jobs WHERE job_id=?").get(frame.job_id) as any;
        if(job) this.db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,?,?,COALESCE(MAX(seq),0)+1,? FROM messages WHERE session_id=?").run(randomUUID(),job.session_id,frame.job_id,JSON.stringify({role:"tool",call_id:frame.call_id,tool:call!.tool_name,arguments:JSON.parse(call!.arguments_json),content:frame.result,ok:frame.ok}),job.session_id);
      })();
      pending.resolve(frame);
    } else if (frame.type === "tool_rejected") {
      // The worker ledger cannot prove this call is safe to run: never retry it.
      const call = this.db.prepare("SELECT request_hash,job_id FROM runtime_calls WHERE call_id=?").get(frame.call_id) as {request_hash:string;job_id:string}|undefined;
      if (!call || call.request_hash !== frame.request_hash || call.job_id !== frame.job_id) return;
      this.db.transaction(() => {
        this.db.prepare("UPDATE runtime_calls SET status='unknown' WHERE call_id=? AND status<>'completed'").run(frame.call_id);
        this.db.prepare("UPDATE tool_calls SET state='unknown' WHERE call_id=? AND state<>'finished'").run(frame.call_id);
        this.db.prepare("UPDATE jobs SET state='needs_attention' WHERE job_id=?").run(frame.job_id);
        this.db.prepare("UPDATE workers SET blocked=1 WHERE worker_id=?").run(frame.worker_id);
      })();
      const pending = this.pending.get(frame.call_id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(frame.call_id); pending.reject(new Error(`tool_rejected:${frame.reason}`)); }
    }
  }

  async dispatch(workerId: string, jobId: string, session: {workspace_id:string;workspace_version:number}, name:string, args:Record<string,unknown>, callId:string): Promise<any> {
    const conn = this.connections.get(workerId);
    if (!conn || conn.socket.readyState !== 1) throw new Error("worker_offline");
    const existing = this.db.prepare("SELECT request_hash,status,result_json,call_seq FROM runtime_calls WHERE job_id=? AND call_id=?").get(jobId,callId) as any;
    const nextSeq=(this.db.prepare("SELECT COALESCE(MAX(call_seq),0)+1 n FROM runtime_calls WHERE job_id=?").get(jobId) as any).n;
    const request = {worker_id:workerId,job_id:jobId,call_id:callId,call_seq:existing?.call_seq ?? Number(nextSeq),workspace_id:session.workspace_id,config_version:session.workspace_version,tool:name,arguments:args};
    const digest = requestHash(request);
    if (existing && existing.request_hash !== digest) throw new Error("call_id_conflict");
    const sequence = request.call_seq;
    this.db.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO runtime_turns(job_id,turn_key,assistant_json,content_hash,committed_at) VALUES(?,?,?,?,?)").run(jobId,`tool:${callId}`,JSON.stringify(request),digest,this.now());
      this.db.prepare("INSERT OR IGNORE INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES(?,?,?,?,?,?,?,?)").run(jobId,`tool:${callId}`,callId,sequence,digest,name,JSON.stringify(args),"dispatched");
      this.db.prepare("INSERT OR IGNORE INTO tool_calls(call_id,job_id,call_seq,request_hash,request_json,state) VALUES(?,?,?,?,?,'accepted')").run(callId,jobId,sequence,digest,JSON.stringify(request));
      this.db.prepare("UPDATE tool_calls SET state='running' WHERE call_id=?").run(callId);
    })();
    this.db.prepare("UPDATE runtime_calls SET status='dispatched' WHERE job_id=? AND call_id=? AND status='committed'").run(jobId,callId);
    if (existing?.status === "completed" && existing.result_json) return JSON.parse(existing.result_json);
    const result = await new Promise<any>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(callId);this.db.prepare("UPDATE runtime_calls SET status='unknown' WHERE call_id=?").run(callId);this.db.prepare("UPDATE jobs SET state='needs_attention' WHERE job_id=?").run(jobId);this.db.prepare("UPDATE workers SET blocked=1 WHERE worker_id=?").run(workerId);reject(new Error("tool_result_timeout"));},1800000);
      this.pending.set(callId,{resolve,reject,timer});
      const wireArgs:Record<string,any>={...args};
      if(name==="write"){
        const content=wireArgs.content;
        if(typeof content!=="string") {clearTimeout(timer);this.pending.delete(callId);reject(new Error("write_content_required"));return;}
        const bytes=Buffer.from(content,"utf8");
        if(bytes.length>1024*1024) {clearTimeout(timer);this.pending.delete(callId);reject(new Error("write_exceeds_1_mib"));return;}
        delete wireArgs.content;
        wireArgs.transfer_bytes=bytes.length;
        wireArgs.transfer_sha256=createHash("sha256").update(bytes).digest("hex");
        wireArgs.transfer_chunks=Math.max(1,Math.ceil(bytes.length/24000));
        conn.socket.send(JSON.stringify({protocol_version:1,type:"tool_call",worker_id:workerId,connection_epoch:conn.epoch,job_id:jobId,call_id:callId,call_seq:sequence,workspace_id:session.workspace_id,config_version:session.workspace_version,request_hash:digest,tool:name,arguments:wireArgs}));
        for(let index=0;index<wireArgs.transfer_chunks;index++){
          const chunk=bytes.subarray(index*24000,Math.min(bytes.length,(index+1)*24000));
          conn.socket.send(JSON.stringify({protocol_version:1,type:"tool_data",worker_id:workerId,connection_epoch:conn.epoch,job_id:jobId,call_id:callId,request_hash:digest,chunk_index:index,data:chunk.toString("base64"),final:index===wireArgs.transfer_chunks-1}));
        }
      } else conn.socket.send(JSON.stringify({protocol_version:1,type:"tool_call",worker_id:workerId,connection_epoch:conn.epoch,job_id:jobId,call_id:callId,call_seq:sequence,workspace_id:session.workspace_id,config_version:session.workspace_version,request_hash:digest,tool:name,arguments:wireArgs}));
    });
    conn.socket.send(JSON.stringify({protocol_version:1,type:"tool_ack",worker_id:workerId,connection_epoch:conn.epoch,job_id:jobId,call_id:callId,request_hash:digest,ack_through:sequence}));
    if (!result.ok) throw new Error(JSON.stringify(result.result));
    return result.result;
  }

  async pump(workerId:string) {
    if (workersInFlight.has(workerId)) return;
    const worker=this.db.prepare("SELECT online,reconciled,blocked FROM workers WHERE worker_id=?").get(workerId) as any;
    if (!worker || !worker.online || !worker.reconciled || worker.blocked) return;
    workersInFlight.add(workerId);
    try {
      while (true) {
        const slot=this.db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id=?").get(workerId) as any;
        if (slot?.active_job_id) return;
        const job=this.db.prepare("SELECT j.*,s.workspace_id,s.workspace_version,s.repo_id,s.path FROM jobs j JOIN sessions s USING(session_id) WHERE j.worker_id=? AND j.state IN ('queued','waiting_worker') ORDER BY j.queue_seq LIMIT 1").get(workerId) as any;
        if (!job) return;
        if (job.wait_until && job.wait_until < this.now()) { this.db.prepare("UPDATE jobs SET state='failed' WHERE job_id=?").run(job.job_id); continue; }
        this.db.transaction(()=>{this.db.prepare("UPDATE worker_slots SET active_job_id=? WHERE worker_id=? AND active_job_id IS NULL").run(job.job_id,workerId);this.db.prepare("UPDATE jobs SET state='running',started_at=?,runtime_generation=runtime_generation+1 WHERE job_id=?").run(this.now(),job.job_id);})();
        if(this.runJob) await this.runJob(job); else await this.runPi(job);
        this.db.prepare("UPDATE worker_slots SET active_job_id=NULL WHERE worker_id=? AND active_job_id=?").run(workerId,job.job_id);
      }
    } catch (e) {
      const active=this.db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id=?").get(workerId) as any;
      const message=String(e);
      const job=this.db.prepare("SELECT job_id FROM jobs WHERE worker_id=? AND state='running' ORDER BY queue_seq LIMIT 1").get(workerId) as any;
      if (job) {
        const state=(this.db.prepare("SELECT state FROM jobs WHERE job_id=?").get(job.job_id) as any).state;
        if(state==="needs_attention") this.db.prepare("UPDATE workers SET blocked=1 WHERE worker_id=?").run(workerId);
        else {this.db.prepare("UPDATE jobs SET state='failed' WHERE job_id=?").run(job.job_id);this.db.prepare("UPDATE worker_slots SET active_job_id=NULL WHERE worker_id=?").run(workerId);}
      } else if(active?.active_job_id) this.db.prepare("UPDATE worker_slots SET active_job_id=NULL WHERE worker_id=?").run(workerId);
      console.error("execution failed",message);
    } finally { workersInFlight.delete(workerId); }
  }

  async runPi(job:any) {
    const fakeMode=process.env.P2_FAKE_MODEL==="1";
    const provider=fakeMode?"openai":(process.env.MODEL_PROVIDER ?? "openrouter");
    const modelName=fakeMode?"gpt-4o-mini":(process.env.MODEL_NAME ?? "deepseek/deepseek-v4.1-flash");
    const apiKey=fakeMode?"p2-scripted-provider":(process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY);
    if (!apiKey) throw new Error("MODEL_API_KEY (or OPENROUTER_API_KEY) is required to execute jobs");
    const pi=await import("@earendil-works/pi-coding-agent");
    const ai=await import("@earendil-works/pi-ai/compat");
    const typebox=await import("typebox");
    const runtime=await pi.ModelRuntime.create({authPath:resolve(process.env.DATA_DIR??"./data","pi-auth.json"),modelsPath:null,modelsStorePath:resolve(process.env.DATA_DIR??"./data","pi-models.json"),refreshOnCreate:false});
    await runtime.setRuntimeApiKey(provider as any,apiKey);
    const model=ai.getModel(provider as any,modelName); if(!model) throw new Error(`unknown Pi model ${provider}/${modelName}`);
    const sessionDir=resolve(process.env.DATA_DIR??"./data","pi-sessions",job.session_id);
    const tools=[
      {name:"read",label:"read",description:"Read bounded UTF-8 text from the fixed remote workspace.",parameters:typebox.Type.Object({path:typebox.Type.String(),offset:typebox.Type.Optional(typebox.Type.Integer({minimum:0})),limit:typebox.Type.Optional(typebox.Type.Integer({minimum:1,maximum:16384}))}),execute:async(id:string,p:any)=>this.piTool(job,id,"read",p)},
      {name:"write",label:"write",description:"Atomically write a UTF-8 file in the fixed remote workspace. expected_hash is the current SHA-256 or 'missing'.",parameters:typebox.Type.Object({path:typebox.Type.String(),content:typebox.Type.String(),expected_hash:typebox.Type.String()}),execute:async(id:string,p:any)=>this.piTool(job,id,"write",p)},
      {name:"bash",label:"bash",description:"Run a non-interactive command in the fixed remote workspace.",parameters:typebox.Type.Object({command:typebox.Type.String()}),execute:async(id:string,p:any)=>this.piTool(job,id,"bash",p)},
    ];
    const mod=await import("./pi-runtime.js");
    const manager=pi.SessionManager.create(job.path,sessionDir);
    let session:any,assistantFinished=false;
    try {
      ({session}=await mod.createPiSession({role:"worker",cwd:job.path,agentDir:resolve(process.env.DATA_DIR??"./data","pi-agent"),sessionDir,sessionManager:manager,model,modelRuntime:runtime,customTools:tools,commitAssistantTurn:async({turnKey,assistantMessage,calls}:any)=>{
        const fingerprint=hash({assistantMessage,calls});
        this.db.transaction(()=>{
          const old=this.db.prepare("SELECT content_hash FROM runtime_turns WHERE job_id=? AND turn_key=?").get(job.job_id,turnKey) as any;
          if(old){if(old.content_hash!==fingerprint) throw new Error("turn_checkpoint_conflict");return;}
          this.db.prepare("INSERT INTO runtime_turns VALUES(?,?,?,?,?)").run(job.job_id,turnKey,JSON.stringify(assistantMessage),fingerprint,this.now());
          const add=this.db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES(?,?,?,?,?,?,?,'committed')");
          let seq=(this.db.prepare("SELECT COALESCE(MAX(call_seq),0) n FROM runtime_calls WHERE job_id=?").get(job.job_id) as any).n;
          for(const c of calls){seq++;const request={worker_id:job.worker_id,job_id:job.job_id,call_id:c.id,call_seq:seq,workspace_id:job.workspace_id,config_version:job.workspace_version,tool:c.name,arguments:c.arguments??{}};add.run(job.job_id,turnKey,c.id,seq,requestHash(request),c.name,JSON.stringify(c.arguments??{}));}
          this.db.prepare("INSERT INTO runtime_history(job_id,entry_key,turn_key,message_json) VALUES(?,?,?,NULL)").run(job.job_id,`turn:${turnKey}`,turnKey);
        })();
        return true;
      },onAssistantTurn:async({message}:any)=>{
        assistantFinished=!message.content?.some((c:any)=>c.type==="toolCall");
        if(assistantFinished) this.db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,?,?,COALESCE(MAX(seq),0)+1,? FROM messages WHERE session_id=?").run(randomUUID(),job.session_id,job.job_id,JSON.stringify({role:"assistant",content:message.content}),job.session_id);
      }}));
      if(fakeMode){
        const faux=await import("@earendil-works/pi-ai");
        const core=faux.createFauxCore({provider:"openai",api:"openai",models:[{id:"gpt-4o-mini"}]});
        const largeContent="P2 large payload block\n".repeat(6000);
        core.setResponses([
          faux.fauxAssistantMessage(faux.fauxToolCall("read",{path:"README.md",offset:0,limit:200},{id:`${job.job_id}-read`}),{stopReason:"toolUse"}),
          faux.fauxAssistantMessage(faux.fauxToolCall("write",{path:"README.md",content:"P2 controlled fixture updated by remote worker; large-frame run verified",expected_hash:process.env.P2_FAKE_README_HASH??"781a5cbce3e95d0c8591508ad2557189dc2189cf7f96034aa06b8e519c1fdf8c"},{id:`${job.job_id}-write`}),{stopReason:"toolUse"}),
          faux.fauxAssistantMessage(faux.fauxToolCall("write",{path:"large.txt",content:largeContent,expected_hash:"missing"},{id:`${job.job_id}-large-write`}),{stopReason:"toolUse"}),
          faux.fauxAssistantMessage(faux.fauxToolCall("bash",{command:`./verify.sh && test "$(wc -c < large.txt | tr -d ' ')" -eq ${Buffer.byteLength(largeContent)}`},{id:`${job.job_id}-bash`}),{stopReason:"toolUse"}),
          faux.fauxAssistantMessage("Read README.md, updated it atomically, transferred a large file in bounded frames, and the remote validation script passed."),
        ]);
        session.agent.streamFunction=core.streamSimple;
      }
      this.db.prepare("INSERT INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)").run(job.job_id,`user:${job.job_id}`,JSON.stringify({role:"user",content:job.input_text}));
      await session.prompt(job.input_text);
      for(let turn=0;!assistantFinished&&turn<20;turn++) await session.agent.continue();
      if(!assistantFinished) throw new Error("model_turn_limit");
      this.db.prepare("UPDATE jobs SET state='succeeded' WHERE job_id=? AND state='running'").run(job.job_id);
    } finally {session?.dispose();await (runtime as any).dispose?.();}
  }

  async piTool(job:any,callId:string,name:string,args:any) {
    const row=this.db.prepare("SELECT status,result_json FROM runtime_calls WHERE job_id=? AND call_id=?").get(job.job_id,callId) as any;
    if(!row) throw new Error("tool_intent_not_committed");
    if(row.status==="completed") {const v=JSON.parse(row.result_json);return {content:[{type:"text",text:JSON.stringify(v.result)}],details:v.result};}
    this.db.prepare("UPDATE runtime_calls SET status='dispatched' WHERE job_id=? AND call_id=? AND status='committed'").run(job.job_id,callId);
    const result=await this.dispatch(job.worker_id,job.job_id,job,name,args,callId);
    return {content:[{type:"text",text:JSON.stringify(result)}],details:result};
  }
}

export function newJobId(){return randomUUID();}
