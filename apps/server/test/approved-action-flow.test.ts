import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage.js";
import {
  actionBinding,
  assertCallMatchesApproval,
  isPostApprovalBashShape,
  nextSessionMessageSeq,
  settleApprovedExecuteJob,
} from "../src/approved-action.js";
import { ExecutionCoordinator } from "../src/execution.js";

test("execute and verify allocate the next session message seq", () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','b','l',1,1,1,0,?)",
  ).run(now);
  db.prepare("INSERT INTO workspaces VALUES('w','repo',1,'/tmp','local',1)").run();
  db.prepare("INSERT INTO budget_roots(root_job_id) VALUES('j0')").run();
  const sessionId = "diag";
  db.prepare(
    "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at,execution_mode) VALUES(?,'worker','w','repo',1,'local','/tmp',?,'diagnosis')",
  ).run(sessionId, now);
  db.prepare(
    "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,root_job_id) VALUES('j0',?,'c','h','','w',1,'succeeded',?, 'j0')",
  ).run(sessionId, now);
  db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) VALUES('m0',?,?,1,'{}')").run(sessionId, "j0");
  assert.equal(nextSessionMessageSeq(db, sessionId), 2);
  db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) VALUES(?,?,?,?,?)").run(
    "m1",
    sessionId,
    "j0",
    nextSessionMessageSeq(db, sessionId),
    "{}",
  );
  assert.equal(nextSessionMessageSeq(db, sessionId), 3);
  db.close();
});

test("post-approval allowlist is bash remediation shapes only", () => {
  assert.equal(isPostApprovalBashShape("docker restart web"), true);
  assert.equal(isPostApprovalBashShape("echo hi"), false);
});

test("settleApprovedExecuteJob marks executed only after a successful tool", () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','b','l',1,1,1,0,?)",
  ).run(now);
  db.prepare("INSERT INTO workspaces VALUES('w','repo',1,'/tmp','local',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at) VALUES('s','worker','w','repo',1,'local','/tmp',?)").run(now);
  db.prepare(
    "INSERT INTO approved_actions(approved_action_id,diagnosis_session_id,worker_id,tool,arguments_json,target,binding_hash,state,proposed_at,approved_at) VALUES('a','s','w','bash','{}','x','h','approved',?,?)",
  ).run(now, now);
  db.prepare(
    "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,approved_action_id,root_job_id) VALUES('j','s','r','h','','w',1,'running',?,'a','j')",
  ).run(now);
  settleApprovedExecuteJob(db, "j", "a", { ok: false, result: { exit_code: 1 } }, now);
  assert.equal((db.prepare("SELECT state FROM approved_actions WHERE approved_action_id='a'").get() as any).state, "approved");
  assert.equal((db.prepare("SELECT state FROM jobs WHERE job_id='j'").get() as any).state, "failed");
  db.prepare("UPDATE approved_actions SET state='approved',executed_at=NULL WHERE approved_action_id='a'").run();
  db.prepare(
    "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,approved_action_id,root_job_id) VALUES('j2','s','r2','h2','','w',2,'running',?,'a','j2')",
  ).run(now);
  settleApprovedExecuteJob(db, "j2", "a", { ok: true, result: { exit_code: 0 } }, now);
  assert.equal((db.prepare("SELECT state FROM approved_actions WHERE approved_action_id='a'").get() as any).state, "executed");
  db.close();
});

test("assertCallMatchesApproval refuses a consumed approval", () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','b','l',1,1,1,0,?)",
  ).run(now);
  db.prepare("INSERT INTO workspaces VALUES('w','repo',1,'/tmp','local',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at) VALUES('s','worker','w','repo',1,'local','/tmp',?)").run(now);
  const args = { command: "kill 42" };
  const binding = actionBinding("w", "bash", args);
  db.prepare(
    `INSERT INTO approved_actions(approved_action_id,diagnosis_session_id,worker_id,tool,arguments_json,target,binding_hash,state,proposed_at,executed_at)
     VALUES('a','s','w','bash',?,?,?,'executed',?,?)`,
  ).run(JSON.stringify(args), "kill 42", binding, now, now);
  assert.throws(() =>
    assertCallMatchesApproval(db, { job_id: "j", worker_id: "w", approved_action_id: "a" }, "bash", args),
  );
  db.close();
});

test("approved execute jobs reject model tool commits", () => {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('venus','boot','ledger',2,1,1,0,?)").run(Date.now());
  db.prepare("INSERT INTO worker_slots(worker_id) VALUES('venus')").run();
  db.prepare("INSERT INTO workspaces VALUES('venus','primary',1,'/tmp','github.com/acme/repo',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path) VALUES('s','worker','venus','primary',1,'github.com/acme/repo','/tmp')").run();
  db.prepare(
    "INSERT INTO approved_actions(approved_action_id,diagnosis_session_id,worker_id,tool,arguments_json,target,binding_hash,state,proposed_at,approved_at) VALUES('a','s','venus','bash','{}','kill 42','h','approved',?,?)",
  ).run(Date.now(), Date.now());
  db.prepare(
    "INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,approved_action_id,root_job_id) VALUES('j','s','r','h','run','venus',1,'running',?,'a','j')",
  ).run(Date.now());
  const coordinator = new ExecutionCoordinator(db, new Map(), () => Date.now(), () => new Promise(() => {}));
  const job = db.prepare("SELECT j.*,s.kind session_kind,s.workspace_id,s.workspace_version,s.repo_id,s.path,s.execution_mode FROM jobs j JOIN sessions s USING(session_id) WHERE j.job_id='j'").get() as any;
  assert.throws(
    () =>
      (coordinator as any).commitTurn(job, "t1", { role: "assistant", content: [] }, [
        { id: "c1", name: "bash", arguments: { command: "kill 42" } },
      ]),
    /approved_execute_no_model_turns/,
  );
  coordinator.close();
  db.close();
});
