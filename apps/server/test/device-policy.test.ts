import test from "node:test";
import assert from "node:assert/strict";
import { requestHash } from "@willcord/protocol";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { deviceExecutionPolicy, effectiveExecutionMode } from "../src/device-policy.js";
import { delegate } from "../src/jobs.js";
import { DEFAULT_BUDGET, ExecutionCoordinator } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";
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

    // Main Agent delegation to a locked device fails instead of silently
    // becoming a diagnosis session (#86, acceptance BLOCK-3).
    db.prepare(
      "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at) VALUES('main','main',NULL,NULL,0,NULL,'.',?)",
    ).run(1001);
    db.prepare(
      "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,state,root_job_id,created_at) VALUES('root','main','c','h','head',NULL,'running','root',?)",
    ).run(1002);
    const delegated = delegate(db, () => 1003, DEFAULT_BUDGET, { job_id: "root", root_job_id: "root" }, "call-d1", { worker_id: "w", workspace_id: "repo", prompt: "请在这台机器上修复磁盘" });
    assert.equal(delegated.record.ok, false, JSON.stringify(delegated));
    assert.equal((delegated.record.result as { error: string }).error, "device_requires_diagnosis");
    assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE parent_job_id='root'").pluck().get(), 0, "no child job is created");
    assert.equal(db.prepare("SELECT count(*) n FROM sessions WHERE parent_job_id='root'").pluck().get(), 0, "no child session is created");

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

test("device policy: a call of a session created before the lock dispatches as diagnosis without a hash mismatch", { timeout: 120000 }, async () => {
  // The acceptance BLOCK-1 repro: a normal session exists, the device is
  // locked, then the first call commits. Commit freezes the effective mode
  // onto the call, so dispatch rebuilds the same request instead of failing
  // with committed_request_hash_mismatch and blocking the worker.
  const s = await startScenario({ scripts: { run: [{ tool: "bash", id: "run", arguments: { command: "ls" } }, { text: "done" }] } });
  try {
    s.startWorker();
    await s.ready();
    const sessionId = await s.createSession();
    s.main.db.prepare("INSERT OR IGNORE INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k','w','linux','x86_64','approved',1,1)").run();
    const lock = await s.main.app.inject({ method: "PATCH", url: "/api/enrollments/w", headers: s.headers, payload: { name: "w", execution_policy: "diagnosis" } });
    assert.equal(lock.statusCode, 200, lock.body);
    const jobId = await s.submit(sessionId, "run");
    await s.until(() => s.state(jobId) === "succeeded");
    const call = s.one("SELECT status,execution_mode FROM runtime_calls WHERE job_id=?", jobId);
    assert.equal(call.status, "completed", "the call dispatched and completed");
    assert.equal(call.execution_mode, "diagnosis", "commit froze the effective mode onto the call");
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE status='unknown'").n, 0, "no committed_request_hash_mismatch");
    assert.equal(s.one("SELECT blocked FROM workers WHERE worker_id='w'").blocked, 0, "the worker stayed unblocked");
    assert.equal(s.one("SELECT count(*) n FROM attention_actions").n, 0, "no needs_attention evidence");
  } finally {
    await s.close();
  }
});

test("device policy: dispatch after the lock is lifted still rebuilds the frozen diagnosis request", { timeout: 120000 }, async () => {
  // Reverse order of the same mismatch class: the call is committed while the
  // device is locked and the worker only receives it after the lock is gone.
  // The request hash must still match because it was computed from the frozen
  // mode, not the session's.
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('venus','k','venus','linux','x86_64','approved',1,1)").run();
  db.prepare("UPDATE enrollments SET execution_policy='diagnosis' WHERE worker_id='venus'").run();
  db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES('venus','boot','ledger',2,1,1,0,?)").run(Date.now());
  db.prepare("INSERT INTO worker_slots(worker_id) VALUES('venus')").run();
  db.prepare("INSERT INTO workspaces VALUES('venus','primary',1,'/tmp','github.com/acme/repo',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path) VALUES('s','worker','venus','primary',1,'github.com/acme/repo','/tmp')").run();
  db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at) VALUES('j','s','r','h','run','venus',1,'running',?)").run(Date.now());
  const sent: any[] = [];
  const socket = { readyState: 1, send: (v: string) => sent.push(JSON.parse(v)) };
  const connections = new Map([["venus", { epoch: 2, socket, tokenDigest: "token" }]]);
  const coordinator = new ExecutionCoordinator(db, connections, Date.now, () => new Promise(() => {}));
  try {
    // Commit the way commit() does: the effective mode, frozen onto the call.
    const request = { worker_id: "venus", job_id: "j", call_id: "c1", call_seq: 1, workspace_id: "primary", config_version: 1, tool: "bash", arguments: { command: "ls" }, execution_mode: "diagnosis" };
    const digest = requestHash(request);
    db.prepare("INSERT INTO runtime_turns VALUES('j','turn-c1','{}','h',?)").run(Date.now());
    db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status,execution_mode) VALUES('j','turn-c1','c1',1,?,'bash',?,'committed','diagnosis')").run(digest, JSON.stringify({ command: "ls" }));

    // The lock is lifted before the call is ever dispatched.
    db.prepare("UPDATE enrollments SET execution_policy=NULL WHERE worker_id='venus'").run();
    const dispatched = coordinator.dispatch("j", "c1");
    assert.equal(sent.length, 1, "the call went out after the unlock");
    assert.equal(sent[0].request_hash, digest, "dispatch rebuilt the frozen diagnosis request");
    assert.equal(sent[0].execution_mode, "diagnosis", "the wire frame still carries the frozen mode");
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_calls WHERE status='unknown'").pluck().get(), 0);
    assert.equal(db.prepare("SELECT blocked FROM workers WHERE worker_id='venus'").pluck().get(), 0);
    coordinator.receive({ protocol_version: 1, type: "tool_result", worker_id: "venus", connection_epoch: 2, job_id: "j", call_id: "c1", request_hash: digest, ok: true, result: { exit_code: 0 } });
    assert.deepEqual(await dispatched, { ok: true, result: { exit_code: 0 } });
  } finally {
    coordinator.close();
    db.close();
  }
});

test("device policy: changing the lock raises a device alert", async () => {
  const db = openDatabase(":memory:");
  let t = 2000;
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => t });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k','w','linux','x86_64','approved',1,1)").run();
    const locked = await admin("PATCH", "/api/enrollments/w", { name: "w", execution_policy: "diagnosis" });
    assert.equal(locked.statusCode, 200);
    const lockAlerts = db.prepare("SELECT entity_id,content_json FROM events WHERE kind='alert'").all() as Array<{ entity_id: string; content_json: string }>;
    assert.equal(lockAlerts.length, 1, "locking raises one alert");
    const lockAlert = JSON.parse(lockAlerts[0].content_json);
    assert.equal(lockAlert.type, "device_policy_changed");
    assert.equal(lockAlert.severity, "warn");
    assert.equal(lockAlert.worker_id, "w");
    assert.match(lockAlert.message, /仅诊断/);

    // A rename-only PATCH changes nothing and raises no second alert.
    await admin("PATCH", "/api/enrollments/w", { name: "renamed" });
    assert.equal((db.prepare("SELECT count(*) n FROM events WHERE kind='alert'").pluck().get() as number), 1);

    // Past the dedupe window, lifting the lock raises its own alert.
    t += 600_001;
    const unlocked = await admin("PATCH", "/api/enrollments/w", { name: "renamed", execution_policy: null });
    assert.equal(unlocked.statusCode, 200);
    const alerts = (db.prepare("SELECT content_json FROM events WHERE kind='alert'").all() as Array<{ content_json: string }>).map((r) => JSON.parse(r.content_json));
    assert.equal(alerts.length, 2);
    assert.equal(alerts[1].type, "device_policy_changed");
    assert.equal(alerts[1].severity, "info");
    assert.match(alerts[1].message, /解除/);
  } finally {
    await app.close();
    db.close();
  }
});

test("device policy: approve is refused for an action proposed before the lock", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => 2000 });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare(
      "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES('w','boot','ledger',1,1,1,0,?)",
    ).run(1000);
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k','w','linux','x86_64','approved',1,1)").run();
    db.prepare(
      "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,execution_mode,created_at) VALUES('d','worker','w','repo',1,'local','/tmp','diagnosis',?)",
    ).run(1000);
    // Proposed while the device was still unrestricted.
    const proposed = await admin("POST", "/api/sessions/d/approved-actions", { tool: "bash", arguments: { command: "kill 4242" } });
    assert.equal(proposed.statusCode, 201, proposed.body);
    const actionId = proposed.json().approved_action_id as string;
    const lock = await admin("PATCH", "/api/enrollments/w", { name: "w", execution_policy: "diagnosis" });
    assert.equal(lock.statusCode, 200);
    const approve = await admin("POST", `/api/approved-actions/${actionId}/approve`, {});
    assert.equal(approve.statusCode, 409);
    assert.equal(approve.json().error, "device_requires_diagnosis");
    assert.equal((await admin("GET", `/api/approved-actions/${actionId}`)).json().state, "proposed", "the action stays unapproved");
  } finally {
    await app.close();
    db.close();
  }
});

test("device policy: execute is refused for an action approved before the lock", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => 2000 });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare(
      "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES('w','boot','ledger',1,1,1,0,?)",
    ).run(1000);
    db.prepare("INSERT INTO enrollments(worker_id,public_key,name,os,arch,state,created_at,updated_at) VALUES('w','k','w','linux','x86_64','approved',1,1)").run();
    db.prepare(
      "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,execution_mode,created_at) VALUES('d','worker','w','repo',1,'local','/tmp','diagnosis',?)",
    ).run(1000);
    const proposed = await admin("POST", "/api/sessions/d/approved-actions", { tool: "bash", arguments: { command: "kill 4242" } });
    assert.equal(proposed.statusCode, 201, proposed.body);
    const actionId = proposed.json().approved_action_id as string;
    const approved = await admin("POST", `/api/approved-actions/${actionId}/approve`, {});
    assert.equal(approved.statusCode, 200, approved.body);
    // The lock lands after the approval; execute must still refuse the write.
    const lock = await admin("PATCH", "/api/enrollments/w", { name: "w", execution_policy: "diagnosis" });
    assert.equal(lock.statusCode, 200);
    const execute = await admin("POST", `/api/approved-actions/${actionId}/execute`, {});
    assert.equal(execute.statusCode, 409, execute.body);
    assert.equal(execute.json().error, "device_requires_diagnosis");
    assert.equal((await admin("GET", `/api/approved-actions/${actionId}`)).json().state, "approved", "the action was not executed");
    assert.equal(db.prepare("SELECT count(*) n FROM jobs WHERE approved_action_id=?").pluck().get(actionId), 0, "no execute job was created");
    assert.equal(db.prepare("SELECT count(*) n FROM runtime_calls").pluck().get(), 0, "no call was committed, so nothing ran");
  } finally {
    await app.close();
    db.close();
  }
});
