import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage.js";
import { actionBinding, assertCallMatchesApproval, getAction, recordAcceptancePass } from "../src/approved-action.js";
import { requestHash } from "@willcord/protocol";
import { workerToolRequestFields } from "../src/approved-action-wire.js";

test("approved action API state machine and binding", () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','b','l',1,1,1,0,?)",
  ).run(now);
  db.prepare("INSERT INTO workspaces VALUES('w','repo',1,'/tmp','local',1)").run();
  const sessionId = "diag";
  db.prepare(
    "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at,execution_mode) VALUES(?,'worker','w','repo',1,'local','/tmp',?,'diagnosis')",
  ).run(sessionId, now);
  const args = { command: "docker restart web" };
  const binding = actionBinding("w", "bash", args);
  const id = "a1";
  db.prepare(
    `INSERT INTO approved_actions(approved_action_id,diagnosis_session_id,worker_id,tool,arguments_json,target,binding_hash,state,proposed_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(id, sessionId, "w", "bash", JSON.stringify(args), "docker restart web", binding, "proposed", now);
  assert.equal(getAction(db, id)?.state, "proposed");
  db.prepare("UPDATE approved_actions SET state='approved',approved_at=? WHERE approved_action_id=?").run(now, id);
  assertCallMatchesApproval(db, { job_id: "j", worker_id: "w", approved_action_id: id }, "bash", args);
  assert.throws(() => assertCallMatchesApproval(db, { job_id: "j", worker_id: "w", approved_action_id: id }, "bash", { command: "docker restart other" }));
  const request = workerToolRequestFields({
    worker_id: "w",
    job_id: "j",
    call_id: "c1",
    call_seq: 1,
    workspace_id: "repo",
    workspace_version: 1,
    tool: "bash",
    arguments: args,
    execution_mode: "approved",
    approved_binding_hash: binding,
  });
  assert.equal(requestHash(request), requestHash({ ...request }));
  for (let pass = 1; pass <= 10; pass++) {
    recordAcceptancePass(db, pass, id, "pass", { pass, binding }, now + pass);
  }
  const passes = db.prepare("SELECT pass_number,outcome FROM approved_action_acceptance_passes ORDER BY pass_number").all();
  assert.equal(passes.length, 10);
  db.close();
});
