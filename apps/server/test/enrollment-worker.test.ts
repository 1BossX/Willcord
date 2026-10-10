import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { startScenario } from "./support/main-node.js";
import { repoRoot, waitFor } from "./support/worker-harness.js";
const exec=promisify(execFile);
test("managed worker joins with a stable identity, runs in automatic workspace, refuses busy edits and recovers authorization",{timeout:60000},async()=>{
 const s=await startScenario({scripts:{cancel:[{tool:"bash",id:"cancel",arguments:{command:"echo started > cancellation-start; sleep 30; echo never >> marker"}},{text:"done"}],timeout:[{tool:"bash",id:"timeout",arguments:{command:"sleep 30; echo never >> marker",timeout_secs:1}},{text:"done"}],run:[{tool:"bash",id:"run",arguments:{command:"echo once >> marker"}},{text:"done"}],hold:[{tool:"bash",id:"hold",arguments:{command:"sleep 3; echo held >> marker"}},{text:"done"}]}});
 const dir=join(s.dir,"managed"),binary=join(repoRoot,"worker/target/debug/worker-plane-worker");
 const env={...process.env,WORKER_PLANE_HOME:dir,SSL_CERT_FILE:join(s.dir,"ca.pem")};delete env.WORKER_TOKEN;
 // rustls-native-certs prefers SSL_CERT_DIR over SSL_CERT_FILE when both are set.
 // Keep this integration fixture isolated to its freshly generated test CA.
 delete env.SSL_CERT_DIR;
 const cli=(...args:string[])=>exec(binary,args,{env,timeout:15000});
 let worker:ChildProcess|undefined,errors="";
 const start=()=>{worker=spawn(binary,["run"],{env:{...env,SSL_CERT_FILE:join(dir,"ca.pem")},stdio:["ignore","ignore","pipe"]});worker.stderr!.on("data",d=>errors+=d);};
 const stop=async()=>{if(worker&&worker.exitCode===null&&worker.signalCode===null){worker.kill("SIGTERM");await waitFor(()=>worker!.exitCode!==null||worker!.signalCode!==null);}};
 try{
  const joined = await cli("join",s.proxy.url.replace("wss:","https:").replace("/ws/worker",""));
  const first=s.one("SELECT worker_id FROM enrollments"),id=first.worker_id;
  assert.ok(joined.stdout.includes(`Fingerprint (SHA-256 of public key): ${id}`));
  // After installation, every CLI operation and the background process should
  // use the managed CA even when the caller does not export SSL_CERT_FILE.
  writeFileSync(join(dir,"ca.pem"),readFileSync(join(s.dir,"ca.pem")),{mode:0o600});
  writeFileSync(join(dir,"service-ca"),join(dir,"ca.pem"),{mode:0o600});
  env.SSL_CERT_FILE = join(dir,"missing-explicit-ca.pem");
  assert.ok(JSON.parse((await cli("status","--json")).stdout).last_error, "explicit CA must take precedence over the saved copy");
  delete env.SSL_CERT_FILE;
  await cli("join",s.proxy.url.replace("wss:","https:").replace("/ws/worker",""));
  assert.equal(s.all("SELECT * FROM enrollments").length,1);
  assert.equal(statSync(join(dir,"identity.pk8")).mode&0o777,0o600);
  assert.equal(statSync(dir).mode&0o777,0o700);
  await s.api("POST",`/api/enrollments/${id}/approve`,{});start();
  const ready=()=>s.one("SELECT reconciled FROM workers WHERE worker_id=?",id)?.reconciled===1;
  await s.until(ready);
  const session=(await s.api("POST","/api/sessions",{worker_id:id,workspace_id:"default"})).json().session_id;
  const job=await s.submit(session,"run");await s.until(()=>s.state(job)==="succeeded");
  assert.equal(readFileSync(join(dir,"workspaces/default/marker"),"utf8"),"once\n");
  const status=JSON.parse((await cli("status","--json")).stdout);assert.equal(status.worker_running,true);assert.equal(status.reconciled,1);assert.equal(status.token,undefined);
  const hold=await s.submit(session,"hold");await s.until(()=>s.state(hold)==="running");
  const connectionEpoch=s.one("SELECT connection_epoch FROM workers WHERE worker_id=?",id).connection_epoch;
  const path=join(s.dir,"existing");mkdirSync(path);
  const before=readFileSync(join(dir,"worker.toml"),"utf8");
  await assert.rejects(()=>cli("workspace","add","existing",path));
  assert.equal(readFileSync(join(dir,"worker.toml"),"utf8"),before);
  await s.until(()=>s.state(hold)==="succeeded");
  assert.equal(s.one("SELECT connection_epoch FROM workers WHERE worker_id=?",id).connection_epoch,connectionEpoch);
  assert.equal(s.one("SELECT online FROM workers WHERE worker_id=?",id).online,1);
  await cli("workspace","add","existing",path);await s.until(ready);
  assert.equal(JSON.parse((await cli("workspace","list")).stdout).length,2);
  const nextSession=(await s.api("POST","/api/sessions",{worker_id:id,workspace_id:"default"})).json().session_id;
  const cancel=await s.submit(nextSession,"cancel");await s.until(()=>existsSync(join(dir,"workspaces/default/cancellation-start")));
  await s.api("POST",`/api/jobs/${cancel}/cancel`,{});await s.until(()=>s.state(cancel)==="cancelled");
  const timeout=await s.submit(nextSession,"timeout");await s.until(()=>s.one("SELECT result_json FROM runtime_calls WHERE job_id=?",timeout)?.result_json);
  assert.equal(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE job_id=?",timeout).result_json).result.termination,"timeout");
  await s.until(()=>s.state(timeout)==="succeeded");
  s.proxy.dropAll();await s.until(ready);
  const ledger=s.one("SELECT ledger_id FROM workers WHERE worker_id=?",id).ledger_id;
  await stop();start();await s.until(ready);
  assert.equal(s.one("SELECT ledger_id FROM workers WHERE worker_id=?",id).ledger_id,ledger);
  await s.api("POST",`/api/enrollments/${id}/revoke`,{});
  await s.until(()=>s.one("SELECT online FROM workers WHERE worker_id=?",id).online===0);
  await stop();start();await new Promise(r=>setTimeout(r,300));assert.equal(s.one("SELECT online FROM workers WHERE worker_id=?",id).online,0);
  await s.api("POST",`/api/enrollments/${id}/approve`,{});await s.until(ready);
  assert.equal(readFileSync(join(dir,"workspaces/default/marker"),"utf8"),"once\nheld\n",errors);
 }finally{await stop();await s.close();}
});
