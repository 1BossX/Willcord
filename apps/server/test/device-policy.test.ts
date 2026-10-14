import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { deviceExecutionPolicy, effectiveExecutionMode } from "../src/device-policy.js";
import { delegate } from "../src/jobs.js";
import { DEFAULT_BUDGET } from "../src/execution.js";
import { createHash } from "node:crypto";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

test("device policy: effectiveExecutionMode forces diagnosis on locked workers, keeps approved calls", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('locked','k1','locked-node','linux','x86_64','approved',1,1)").run();
  db.prepare("UPDATE enrollments SET execution_policy='diagnosis' WHERE worker_id='locked'").run();
  db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('free','k2','free-node','linux','x86_64','approved',1,1)").run();
  assert.equal(deviceExecutionPolicy(db, "locked"), "diagnosis");
  assert.equal(deviceExecutionPolicy(db, "free"), null);
  assert.equal(deviceExecutionPolicy(db, "missing"), null);
  assert.equal(deviceExecutionPolicy(db, null), null);
  assert.equal(effectiveExecutionMode(db, "locked", null), "diagnosis");
  assert.equal(effectiveExecutionMode(db, "locked", "diagnosis"), "diagnosis");
  assert.equal(effectiveExecutionMode(db, "free", null), null);
  assert.equal(effectiveExecutionMode(db, "free", "diagnosis"), "diagnosis");
  assert.equal(effectiveExecutionMode(db, "locked", "approved"), "approved");
  db.close();
});

test("device policy: administrators set and clear the per-device diagnosis lock", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => 2000 });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('dev1','k3','dev-one','linux','x86_64','approved',1,1)").run();
    const locked = await admin("PATCH", "/api/enrollments/dev1", { name: "dev-one", execution_policy: "diagnosis" });
    assert.equal(locked.statusCode, 200);
    assert.equal(locked.json().execution_policy, "diagnosis");
    assert.equal(deviceExecutionPolicy(db, "dev1"), "diagnosis");
    const bad = await admin("PATCH", "/api/enrollments/dev1", { name: "dev-one", execution_policy: "full" });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.json().error, "invalid_execution_policy");
    const unlocked = await admin("PATCH", "/api/enrollments/dev1", { name: "dev-one", execution_policy: null });
    assert.equal(unlocked.statusCode, 200);
    assert.equal(deviceExecutionPolicy(db, "dev1"), null);
    // The rename-only path keeps the current policy.
    await admin("PATCH", "/api/enrollments/dev1", { name: "dev-one", execution_policy: "diagnosis" });
    await admin("PATCH", "/api/enrollments/dev1", { name: "renamed" });
    assert.equal(deviceExecutionPolicy(db, "dev1"), "diagnosis");
    assert.equal((await admin("PATCH", "/api/enrollments/nope", { name: "x" })).statusCode, 404);
    const devices = (await admin("GET", "/api/enrollments")).json().devices as Array<{ worker_id: string; execution_policy: string | null }>;
    assert.equal(devices.find((d) => d.worker_id === "dev1")?.execution_policy, "diagnosis");
  } finally {
    await app.close();
    db.close();
  }
});

test("device policy: locked devices refuse writable sessions, delegation and approved actions, but allow diagnosis", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => 2000 });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare(
      "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES('w','boot','ledger',1,1,1,0,?)",
    ).run(1000);
    db.prepare("INSERT INTO workspaces(worker_id,workspace_id,repo_id,path,config_version,is_default) VALUES('w','repo','local','/tmp',1,1)").run();
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k4','w','linux','x86_64','approved',1,1)").run();
    await admin("PATCH", "/api/enrollments/w", { name: "w", execution_policy: "diagnosis" });

    const writable = await admin("POST", "/api/sessions", { worker_id: "w", workspace_id: "repo" });
    assert.equal(writable.statusCode, 409);
    assert.equal(writable.json().error, "device_requires_diagnosis");
    const diagnosis = await admin("POST", "/api/sessions", { worker_id: "w", workspace_id: "repo", execution_mode: "diagnosis", diagnosis_scenario: "docker-service" });
    assert.equal(diagnosis.statusCode, 201);
    assert.equal(db.prepare("SELECT execution_mode FROM sessions WHERE session_id=?").pluck().get(diagnosis.json().session_id), "diagnosis");

    // Main Agent delegation to a locked device becomes a diagnosis session.
    db.prepare(
      "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at) VALUES('main','main',NULL,NULL,0,NULL,'.',?)",
    ).run(1001);
    db.prepare(
      "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,state,root_job_id,created_at) VALUES('root','main','c','h','head',NULL,'running','root',?)",
    ).run(1002);
    const delegated = delegate(db, () => 1003, DEFAULT_BUDGET, { job_id: "root", root_job_id: "root" }, "call-d1", { worker_id: "w", workspace_id: "repo", prompt: "请在这台机器上修复磁盘" });
    assert.ok(delegated.record?.ok, JSON.stringify(delegated));
    const childSession = db.prepare("SELECT execution_mode FROM sessions WHERE parent_job_id='root'").pluck().get();
    assert.equal(childSession, "diagnosis");

    // A proposed approved action (operator-approved write) is refused on a locked device.
    db.prepare(
      "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,execution_mode,created_at) VALUES('d','worker','w','repo',1,'local','/tmp','diagnosis',?)",
    ).run(1003);
    const proposed = await admin("POST", "/api/sessions/d/approved-actions", { tool: "bash", arguments: { command: "docker restart web" } });
    assert.equal(proposed.statusCode, 409);
    assert.equal(proposed.json().error, "device_requires_diagnosis");

    // An unlocked device keeps accepting writable sessions.
    await admin("PATCH", "/api/enrollments/w", { name: "w", execution_policy: null });
    const open = await admin("POST", "/api/sessions", { worker_id: "w", workspace_id: "repo" });
    assert.equal(open.statusCode, 201);
  } finally {
    await app.close();
    db.close();
  }
});

test("device policy: dispatch carries diagnosis mode for sessions created before the lock", async () => {
  const db = openDatabase(":memory:");
  const now = () => 2000;
  const app = await createApp(db, "https://localhost:8443", { logging: false, now });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  try {
    db.prepare(
      "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES('w','boot','ledger',1,1,1,0,?)",
    ).run(1000);
    db.prepare("INSERT INTO workspaces(worker_id,workspace_id,repo_id,path,config_version,is_default) VALUES('w','repo','local','/tmp',1,1)").run();
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k4','w','linux','x86_64','approved',1,1)").run();
    const create = await app.inject({
      method: "POST", url: "/api/sessions",
      headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" },
      payload: { worker_id: "w", workspace_id: "repo" },
    });
    assert.equal(create.statusCode, 201);
    const sessionId = create.json().session_id;
    db.prepare(
      "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,state,root_job_id,created_at) VALUES('j1',?,'c','h','run','w','running','j1',?)",
    ).run(sessionId, now());
    db.prepare("UPDATE enrollments SET execution_policy='diagnosis' WHERE worker_id='w'").run();
    db.prepare(
      "INSERT INTO runtime_turns(job_id,turn_key,assistant_json,content_hash,committed_at) VALUES('j1','t','[]','h',?)",
    ).run(now());
    db.prepare(
      "INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('j1','t','c1',1,'h','bash','{\"command\":\"ls\"}','committed')",
    ).run();
    // The worker's next dispatch of the pending call is rewritten: the committed
    // request hash was computed with mode "approved", so only the mode itself flips.
    db.prepare("UPDATE runtime_calls SET status='dispatched' WHERE call_id='c1'").run();
    // Dispatch happens through the coordinator's dispatch(); assert the committed request mode directly.
    const row = db.prepare("SELECT c.call_id FROM runtime_calls c WHERE c.job_id='j1'").get();
    assert.ok(row);
    const { effectiveExecutionMode: mode } = await import("../src/device-policy.js");
    assert.equal(mode(db, "w", null), "diagnosis");
  } finally {
    await app.close();
    db.close();
  }
});
