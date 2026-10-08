import { test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import {ExecutionCoordinator} from "../src/execution.js";

test("P2 fixed target session, repo guard, offline FIFO and request idempotency",async()=>{
 const db=openDatabase(":memory:");
 db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash("p2-test-password",{type:argon2.argon2id}));
 db.prepare("INSERT INTO workers VALUES ('venus','boot','ledger',1,0,0,0,?)").run(Date.now());
 db.prepare("INSERT INTO worker_slots(worker_id) VALUES ('venus')").run();
 db.prepare("INSERT INTO workspaces VALUES ('venus','repo-a',1,'/tmp/p2-a','github.com/acme/a',1)").run();
 const app=await createApp(db,"https://localhost:8443",{logging:false});
 try{
  const signedOut=await app.inject({url:"/auth/session"});assert.equal(signedOut.statusCode,200);assert.deepEqual(signedOut.json(),{authenticated:false});
  const login=await app.inject({method:"POST",url:"/auth/login",headers:{origin:"https://localhost:8443"},payload:{password:"p2-test-password"}});
  const cookie=login.headers["set-cookie"]!.toString().split(";")[0],csrf=login.json().csrf;
  const headers={cookie,origin:"https://localhost:8443","x-csrf-token":csrf};
  assert.equal((await app.inject({url:"/auth/session",headers:{cookie}})).json().csrf,csrf);
  const wrong=await app.inject({method:"POST",url:"/api/sessions",headers,payload:{worker_id:"venus",workspace_id:"repo-a",repo_id:"github.com/acme/b"}});
  assert.equal(wrong.statusCode,409);
  const created=await app.inject({method:"POST",url:"/api/sessions",headers,payload:{worker_id:"venus",workspace_id:"repo-a",repo_id:"github.com/acme/a"}});
  assert.equal(created.statusCode,201);
  const session=created.json().session_id as string;
  const submit={method:"POST" as const,url:`/api/sessions/${session}/messages`,headers,payload:{client_request_id:"request-1",message:"inspect the repository"}};
  const first=await app.inject(submit); assert.equal(first.statusCode,202);assert.equal(first.json().state,"waiting_worker");
  const retry=await app.inject(submit);assert.equal(retry.statusCode,200);assert.equal(retry.json().job_id,first.json().job_id);
  const conflict=await app.inject({...submit,payload:{client_request_id:"request-1",message:"different payload"}});assert.equal(conflict.statusCode,409);
  const jobs=await app.inject({url:`/api/sessions/${session}/jobs`,headers:{cookie}});assert.equal(jobs.json().length,1);
  assert.equal(jobs.json()[0].input_text,"inspect the repository");assert.equal(jobs.json()[0].queue_position,1);
  assert.equal((await app.inject({url:`/api/sessions/${session}/messages`,headers:{cookie}})).json().length,1);
  const secondSession=(await app.inject({method:"POST",url:"/api/sessions",headers,payload:{worker_id:"venus",workspace_id:"repo-a"}})).json().session_id;
  await app.inject({method:"POST",url:`/api/sessions/${secondSession}/messages`,headers,payload:{client_request_id:"request-2",message:"second session task"}});
  const secondJobs=(await app.inject({url:`/api/sessions/${secondSession}/jobs`,headers:{cookie}})).json();assert.equal(secondJobs[0].queue_position,2);
  db.prepare("UPDATE worker_slots SET active_job_id=? WHERE worker_id='venus'").run(first.json().job_id);
  const worker=(await app.inject({url:"/api/workers",headers:{cookie}})).json()[0];assert.equal(worker.online,0);assert.equal(worker.active_job_id,first.json().job_id);
 }finally{await app.close();db.close();}
});

test("P2 worker FIFO is shared across sessions and holds one persistent slot",async()=>{
 const db=openDatabase(":memory:");db.prepare("INSERT INTO workers VALUES('venus','boot','ledger',1,1,1,0,?)").run(Date.now());db.prepare("INSERT INTO worker_slots(worker_id) VALUES('venus')").run();
 db.prepare("INSERT INTO workspaces VALUES('venus','primary',1,'/tmp','github.com/acme/repo',1)").run();
 for(const id of ["s1","s2"]) db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path) VALUES(?,'worker','venus','primary',1,'github.com/acme/repo','/tmp')").run(id);
 const add=db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at) VALUES(?,?,?,?,?,'venus',?,'queued',?)");
 add.run("j1","s1","r1","h1","first",1,1);add.run("j2","s2","r2","h2","second",2,2);
 const order:string[]=[];let active=0,maxActive=0;
 const coordinator=new ExecutionCoordinator(db,new Map(),Date.now,async(job:any)=>{active++;maxActive=Math.max(maxActive,active);assert.equal((db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id='venus'").get() as any).active_job_id,job.job_id);order.push(job.job_id);await new Promise(resolve=>setTimeout(resolve,5));db.prepare("UPDATE jobs SET state='succeeded' WHERE job_id=?").run(job.job_id);active--;});
 await Promise.all([coordinator.pump("venus"),coordinator.pump("venus")]);
 assert.deepEqual(order,["j1","j2"]);assert.equal(maxActive,1);assert.equal((db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id='venus'").get() as any).active_job_id,null);
 db.close();
});
