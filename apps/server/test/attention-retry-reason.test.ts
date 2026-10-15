// #109 acceptance: retry attention actions carry a readable reason (source
// job/calls, failure, suggested action), old rows are explained from the jobs
// they point at or marked as legacy, and operators can handle or dismiss them.
import { test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";

test("the migration adds the resolution columns attention actions need", () => {
  const db = openDatabase(":memory:");
  const columns = (db.prepare("PRAGMA table_info(attention_actions)").all() as { name: string }[]).map((c) => c.name);
  assert.ok(columns.includes("handled_at"), columns.join(","));
  assert.ok(columns.includes("dismissed_at"), columns.join(","));
  db.close();
});

async function fixture() {
  const db = openDatabase(":memory:");
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash("p109-password", { type: argon2.argon2id }));
  db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES ('venus','boot','ledger',1,0,0,0,?)").run(Date.now());
  db.prepare("INSERT INTO worker_slots(worker_id) VALUES ('venus')").run();
  db.prepare("INSERT INTO workspaces VALUES ('venus','primary',1,'/tmp/p109','github.com/acme/repo',1)").run();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at,title) VALUES('s','worker','venus','primary',1,'github.com/acme/repo','/tmp/p109',?,?)").run(Date.now(), "清理构建缓存");
  /** A finished worker job with one recorded call, so the reason has source data to name. */
  const insertJob = (jobId: string, endReason = "model_error") => {
    db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,end_reason,created_at,root_job_id) VALUES(?,?,'r','h','清理构建缓存','venus',1,'failed',?,?,?)").run(jobId, "s", endReason, Date.now(), jobId);
    db.prepare("INSERT INTO runtime_turns(job_id,turn_key,assistant_json,content_hash,committed_at) VALUES(?,'turn-1','{}','h',?)").run(jobId, Date.now());
    db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES(?,'turn-1','c1',1,'h','bash',?,'not_executed')").run(jobId, JSON.stringify({ command: "rm -rf build" }));
  };
  insertJob("j1");
  const app = await createApp(db, "https://localhost:8443", { logging: false });
  const login = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: "https://localhost:8443" }, payload: { password: "p109-password" } });
  const headers = { cookie: login.headers["set-cookie"]!.toString().split(";")[0], origin: "https://localhost:8443", "x-csrf-token": login.json().csrf };
  const retryActions = () => (db.prepare("SELECT * FROM attention_actions WHERE action='retry'").all() as any[]);
  return { db, app, headers, insertJob, retryActions };
}

test("a retry attention action records source job, failure reason and suggested action (#109)", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    const retry = await app.inject({ method: "POST", url: "/api/jobs/j1/retry", headers });
    assert.equal(retry.statusCode, 202, retry.body);
    const newJobId = retry.json().job_id as string;

    const view = (await app.inject({ url: "/api/attention", headers })).json();
    const action = view.actions.find((a: any) => a.action === "retry");
    assert.ok(action, "the retry appears in /api/attention");
    assert.equal(action.job_id, "j1");
    assert.equal(action.evidence.new_job_id, newJobId);
    const reason = action.reason;
    assert.equal(reason.origin, "recorded");
    assert.equal(reason.source_job_id, "j1");
    assert.equal(reason.source_job_state, "failed");
    assert.equal(reason.source_end_reason, "model_error");
    assert.equal(reason.new_job_id, newJobId);
    assert.ok(typeof reason.summary === "string" && reason.summary.length > 0);
    assert.match(reason.summary, /清理构建缓存/, "the summary names the task by its title");
    assert.match(reason.summary, /新建重试/);
    assert.match(reason.summary, /模型服务调用失败/, "the failure reason is human-readable");
    assert.match(reason.summary, /bash/, "the source call is named");
    assert.match(reason.suggested, /核对原任务已产生的副作用/);
  } finally { await app.close(); db.close(); }
});

test("an operator can mark a retry item handled and it stops being listed", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    await app.inject({ method: "POST", url: "/api/jobs/j1/retry", headers });
    const actionId = retryActions()[0].action_id as string;

    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/handle`, headers, payload: { note: "已确认只删了缓存文件" } })).statusCode, 200);
    assert.ok(retryActions()[0].handled_at != null);
    assert.equal(JSON.parse(retryActions()[0].evidence).handled_note, "已确认只删了缓存文件");
    const view = (await app.inject({ url: "/api/attention", headers })).json();
    assert.equal(view.actions.find((a: any) => a.action_id === actionId), undefined, "a handled item leaves the attention list");

    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/handle`, headers })).statusCode, 409, "resolving twice is rejected");
    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/dismiss`, headers })).statusCode, 409, "dismiss after handle is rejected");
    assert.equal(JSON.parse(retryActions()[0].evidence).reason.origin, "recorded", "the recorded reason is kept");
  } finally { await app.close(); db.close(); }
});

test("an operator can dismiss a retry item, and invalid resolutions are rejected", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    await app.inject({ method: "POST", url: "/api/jobs/j1/retry", headers });
    const actionId = retryActions()[0].action_id as string;

    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/handle`, headers, payload: { note: 42 } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/handle`, headers, payload: { note: "x".repeat(2001) } })).statusCode, 400);
    assert.equal(retryActions()[0].handled_at, null, "a rejected note changes nothing");

    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/dismiss`, headers })).statusCode, 200);
    assert.ok(retryActions()[0].dismissed_at != null);
    const view = (await app.inject({ url: "/api/attention", headers })).json();
    assert.equal(view.actions.find((a: any) => a.action_id === actionId), undefined);
    assert.equal((await app.inject({ method: "POST", url: `/api/attention/actions/${actionId}/dismiss`, headers })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/attention/actions/does-not-exist/dismiss", headers })).statusCode, 404);
  } finally { await app.close(); db.close(); }
});

test("only retry items can be resolved; blocked and unblock items keep their own flow", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    db.prepare("INSERT INTO attention_actions(action_id,worker_id,job_id,action,evidence,created_at) VALUES('a-blocked','venus','j1','blocked',?,?)").run(JSON.stringify({ reason: "worker_reports_unknown_execution", evidence: {} }), Date.now());
    assert.equal((await app.inject({ method: "POST", url: "/api/attention/actions/a-blocked/handle", headers })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/attention/actions/a-blocked/dismiss", headers })).statusCode, 409);
    const view = (await app.inject({ url: "/api/attention", headers })).json();
    assert.equal(view.actions.find((a: any) => a.action_id === "a-blocked").reason, undefined, "non-retry actions are untouched");
    assert.equal(retryActions().length, 0);
  } finally { await app.close(); db.close(); }
});

test("legacy retry rows are explained from their job records when possible", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    // A row written before #109: only the new job id, no reason.
    db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,end_reason,created_at,root_job_id) VALUES('j1-new','s','retry:old','h','清理构建缓存','venus',NULL,'cancelled','cancelled_by_user',?,'j1-new')").run(Date.now());
    db.prepare("INSERT INTO attention_actions(action_id,worker_id,job_id,action,evidence,created_at) VALUES('a-old','venus','j1','retry',?,?)").run(JSON.stringify({ new_job_id: "j1-new" }), Date.now());
    const view = (await app.inject({ url: "/api/attention", headers })).json();
    const reason = view.actions.find((a: any) => a.action_id === "a-old").reason;
    assert.equal(reason.origin, "backfilled");
    assert.equal(reason.source_job_id, "j1");
    assert.match(reason.summary, /旧版本记录/);
    assert.match(reason.summary, /清理构建缓存/);
    assert.match(reason.summary, /模型服务调用失败/);
    assert.equal(reason.new_job_id, "j1-new");

    // The source job is gone (e.g. purged by retention): the item becomes legacy.
    db.pragma("foreign_keys = OFF");
    db.prepare("DELETE FROM jobs WHERE job_id='j1'").run();
    db.pragma("foreign_keys = ON");
    const after = (await app.inject({ url: "/api/attention", headers })).json();
    const legacy = after.actions.find((a: any) => a.action_id === "a-old").reason;
    assert.equal(legacy.origin, "legacy");
    assert.match(legacy.summary, /历史遗留项/);
    assert.match(legacy.summary, /j1-new/, "the surviving new job is still named");
    assert.ok(retryActions()[0].handled_at == null);

    assert.equal((await app.inject({ method: "POST", url: "/api/attention/actions/a-old/dismiss", headers })).statusCode, 200, "a legacy item can be dismissed");
    assert.equal(retryActions()[0].dismissed_at != null, true);
  } finally { await app.close(); db.close(); }
});

test("a legacy row nothing can explain says so and can be dismissed", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    db.prepare("INSERT INTO attention_actions(action_id,worker_id,job_id,action,evidence,created_at) VALUES('a-orphan','venus',NULL,'retry',?,?)").run(JSON.stringify({}), Date.now());
    const view = (await app.inject({ url: "/api/attention", headers })).json();
    const reason = view.actions.find((a: any) => a.action_id === "a-orphan").reason;
    assert.equal(reason.origin, "legacy");
    assert.match(reason.summary, /历史遗留项/);
    assert.match(reason.summary, /无法还原/);
    assert.match(reason.suggested, /忽略或关闭/);
    assert.equal((await app.inject({ method: "POST", url: "/api/attention/actions/a-orphan/dismiss", headers })).statusCode, 200);
  } finally { await app.close(); db.close(); }
});

test("a Main job retry records the reason in its event, not in attention_actions", async () => {
  const { db, app, headers, retryActions } = await fixture();
  try {
    db.prepare("INSERT INTO sessions(session_id,kind,created_at,title) VALUES('main','main',?,'Main Agent')").run(Date.now());
    db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,state,end_reason,created_at,root_job_id) VALUES('jm','main','r','h','巡检','failed','model_error',?,'jm')").run(Date.now());
    const retry = await app.inject({ method: "POST", url: "/api/jobs/jm/retry", headers });
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(retryActions().length, 0, "attention_actions is per worker");
    const event = JSON.parse(db.prepare("SELECT content_json FROM events WHERE content_json LIKE '%job_retried%' ORDER BY event_id DESC LIMIT 1").get().content_json);
    assert.equal(event.type, "job_retried");
    assert.equal(event.job_id, "jm");
    assert.equal(event.reason.origin, "recorded");
    assert.equal(event.reason.source_job_id, "jm");
    assert.match(event.reason.summary, /Main Agent/);
  } finally { await app.close(); db.close(); }
});
