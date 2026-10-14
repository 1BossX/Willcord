import { test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { DIAGNOSIS_INTERCEPT_PROBE_PATH } from "../src/diagnosis-policy.js";

test("diagnosis intercept check creates a write call job", async () => {
  const db = openDatabase(":memory:");
  const now = Date.now();
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(
    await argon2.hash("probe-test-password", { type: argon2.argon2id }),
  );
  db.prepare(
    "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('w','boot','ledger',1,1,1,0,?)",
  ).run(now);
  db.prepare("INSERT INTO workspaces VALUES('w','repo',1,'/tmp','local',1)").run();
  db.prepare(
    "INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at,execution_mode,diagnosis_scenario) VALUES('s','worker','w','repo',1,'local','/tmp',?,'diagnosis','docker-service')",
  ).run(now);
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => now });
  try {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://localhost:8443" },
      payload: { password: "probe-test-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"]?.toString().split(";")[0] ?? "";
    const csrf = login.json().csrf as string;
    assert.ok(csrf, "login should return csrf");
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/s/diagnosis-intercept-check",
      headers: { cookie, origin: "https://localhost:8443", "x-csrf-token": csrf },
    });
    assert.equal(res.statusCode, 202);
    const body = res.json() as { job_id: string; call_id: string };
    const call = db
      .prepare("SELECT tool_name,status,arguments_json FROM runtime_calls WHERE job_id=? AND call_id=?")
      .get(body.job_id, body.call_id) as { tool_name: string; status: string; arguments_json: string };
    assert.equal(call.tool_name, "write");
    assert.equal(call.status, "committed");
    assert.equal(JSON.parse(call.arguments_json).path, DIAGNOSIS_INTERCEPT_PROBE_PATH);
  } finally {
    await app.close();
    db.close();
  }
});
