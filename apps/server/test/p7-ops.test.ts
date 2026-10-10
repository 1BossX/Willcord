// P7-A: operating the main node. Dispatch pause and resume, online backup and
// restore against a real worker ledger, token rotation, retention, the disk
// check, graceful worker stop, and the boundaries every public entry keeps.
import { test } from "node:test";
import Database from "better-sqlite3";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase, MIGRATIONS } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { ROLE_TOOLS } from "../src/pi-runtime.js";
import { backup, inspect, restore } from "../src/ops.js";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";
import { repoRoot } from "./support/worker-harness.js";

type Scenario = Awaited<ReturnType<typeof startScenario>>;
const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const health = async (s: Scenario) => (await s.main.app.inject({ method: "GET", url: "/health" })).json();
const mainSession = async (s: Scenario) => (await s.api("GET", "/api/main")).json().session_id as string;

test("P7-A a paused node starts nothing, reports not ready, and resumes on an operator note", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { held: bash("held-1", "echo held >> marker.log"), plan: [{ text: "main done" }] } });
  try {
    s.startWorker(); await s.ready();
    assert.equal((await s.api("POST", "/api/ops/pause", {})).statusCode, 400, "a pause needs a note");
    assert.equal((await s.api("POST", "/api/ops/pause", { note: "before upgrade" })).statusCode, 200);
    assert.deepEqual(await health(s), { alive: true, scheduling_ready: false, dispatch_paused: "operator", phase: "P7" });
    const job = await s.submit(await s.createSession(), "held");
    const main = await s.submit(await mainSession(s), "plan");
    await sleep(1500);
    assert.equal(s.state(job), "queued", "a ready worker is not given work while paused");
    assert.equal(s.state(main), "queued", "the Main session does not advance either");
    assert.equal(s.count("held"), 0);
    // The pause reaches the UI through the feed.
    assert.equal((await s.api("GET", "/api/snapshot")).json().dispatch.reason, "operator");
    assert.equal((await s.api("POST", "/api/ops/resume", {})).statusCode, 400, "a resume needs a note");
    assert.equal((await s.api("POST", "/api/ops/resume", { note: "upgrade done" })).statusCode, 200);
    await s.until(() => s.state(job) === "succeeded" && s.state(main) === "succeeded");
    assert.equal(s.count("held"), 1);
    assert.equal((await health(s)).scheduling_ready, true);
    assert.equal((await s.api("POST", "/api/ops/resume", { note: "again" })).statusCode, 409);
    const audit = s.all("SELECT content_json FROM events WHERE kind IS NULL").map((r) => JSON.parse(r.content_json)).find((e) => e.type === "dispatch_resumed");
    assert.deepEqual(audit, { type: "dispatch_resumed", paused_for: "operator", note: "upgrade done", unreconciled: [] });
  } finally { await s.close(); }
});

/**
 * A backup taken while slow-1 runs, then restored after the worker finished it
 * and also ran after-1, which the backup never saw. `ackAfter` decides whether
 * the worker ledger recorded after-1 as acknowledged before it stopped.
 */
async function midCallRestore(ackAfter: boolean) {
  let dropAck = !ackAfter;
  const s = await startScenario({
    scripts: {
      slow: bash("slow-1", "echo slow >> marker.log; sleep 3"),
      after: bash("after-1", "echo after >> marker.log"),
      next: bash("next-1", "echo next >> marker.log"),
    },
    drop: (direction, frame) => dropAck && direction === "to_worker" && frame.type === "tool_ack" && frame.call_id === "after-1",
  });
  const copy = join(s.dir, "backup.sqlite");
  // The worker's own ledger, read beside the running worker.
  const ledger = (callId: string) => {
    const db = new Database(join(s.dir, "w-data", "ledger.sqlite"), { readonly: true, fileMustExist: true });
    try { return (db.prepare("SELECT status FROM calls WHERE call_id=?").get(callId) as { status: string } | undefined)?.status; } finally { db.close(); }
  };
  s.startWorker(); await s.ready();
  const session = await s.createSession();
  const slow = await s.submit(session, "slow");
  await s.until(() => s.count("slow") === 1);
  // Online: the main node keeps running and writing while the copy is taken.
  const summary = await backup(s.dir, copy);
  assert.equal(summary.integrity, "ok");
  assert.equal(summary.schema, "013_enrollment.sql");
  assert.equal(summary.unsettled_calls, 1, "the copy holds the call as dispatched");
  assert.deepEqual(inspect(copy), summary);
  await s.until(() => s.state(slow) === "succeeded");
  // Work the backup will not know about.
  const after = await s.submit(session, "after");
  await s.until(() => s.state(after) === "succeeded");
  // The worker's ledger is settled before it stops: what it holds is the scenario, not a race.
  await s.until(() => ledger("slow-1") === "acked" && ledger("after-1") === (ackAfter ? "acked" : "completed"));
  // ACKs stay dropped until the worker is gone: a result it repeats before
  // stopping must not get acknowledged after the check above.
  await s.stopWorker("SIGTERM");
  dropAck = false;
  assert.equal(ledger("after-1"), ackAfter ? "acked" : "completed");
  await s.stopMain();
  mkdirSync(join(s.dir, "main.lock"));
  assert.throws(() => restore(s.dir, copy), /stop the main node/);
  rmSync(join(s.dir, "main.lock"), { recursive: true });
  const restored = restore(s.dir, copy);
  assert.ok(restored.replaced && existsSync(restored.replaced), "the replaced database is kept aside, not deleted");
  await s.startMain();
  assert.equal(s.one("SELECT 1 FROM jobs WHERE job_id=?", after), undefined, "the restored records end before the second job");
  assert.equal(s.callStatus("slow-1"), "dispatched");
  await new Promise((r) => setImmediate(r));
  assert.equal((await health(s)).dispatch_paused, "restored");
  assert.equal((await s.api("POST", "/api/ops/resume", { note: "too early" })).json().error, "workers_not_reconciled");

  s.startWorker();
  await s.until(() => s.one("SELECT reconciled FROM workers").reconciled === 1);
  await sleep(1000);
  assert.equal(s.callStatus("slow-1"), "dispatched", "nothing is re-sent before the operator resumes");
  assert.equal((await s.api("POST", "/api/ops/resume", { note: "ledgers checked" })).statusCode, 200);
  return { s, slow, session };
}

test("P7-A a backup taken mid-call restores paused, and the call it holds as in flight never runs twice", { timeout: 90000 }, async () => {
  const { s, slow, session } = await midCallRestore(true);
  try {
    // The worker ledger answers with the stored result; the call is not executed again.
    await s.until(() => s.state(slow) === "succeeded");
    assert.equal(s.callStatus("slow-1"), "completed");
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
    const next = await s.submit(session, "next");
    await s.until(() => s.state(next) === "succeeded");
    assert.equal(s.count("slow"), 1, "the in-flight call ran once");
    assert.equal(s.count("after"), 1, "the call the backup lacked never ran again");
  } finally { await s.close(); }
});

test("P7-A after a restore, an unacknowledged call the backup lacks blocks the worker; nothing runs again", { timeout: 90000 }, async () => {
  const { s, session } = await midCallRestore(false);
  try {
    await s.until(() => s.one("SELECT blocked FROM workers").blocked === 1, 40000).catch((error) => {
      throw new Error(`${error}: ${JSON.stringify({
        worker: s.one("SELECT online,reconciled,blocked FROM workers"),
        call: s.one("SELECT status FROM runtime_calls WHERE call_id='slow-1'"),
        attention: s.all("SELECT action,evidence FROM attention_actions"),
        frames: s.proxy.frames.slice(-16).map((f) => `${f.direction}:${f.type}:${f.call_id ?? ""}${f.dropped ? ":dropped" : ""}`),
        stderr: s.worker?.stderr().slice(-2000),
      })}`);
    });
    const reasons = s.all("SELECT evidence FROM attention_actions WHERE action='blocked'").map((r) => JSON.parse(r.evidence));
    assert.ok(reasons.some((e) => e.reason === "ledger_contradiction" && e.evidence.call_id === "after-1"), JSON.stringify(reasons));
    const next = await s.submit(session, "next");
    await sleep(1500);
    assert.equal(s.callStatus("slow-1"), "dispatched", "a blocked worker is sent nothing");
    assert.notEqual(s.state(next), "succeeded");
    assert.equal(s.count("slow"), 1);
    assert.equal(s.count("after"), 1);
    assert.equal(s.count("next"), 0);
  } finally { await s.close(); }
});

test("P7-A an upgrade keeps unsettled calls, dedupe watermarks and parent waits, and a copy of the old database", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-upgrade-"));
  try {
    const old = join(dir, "migrations-p6");
    mkdirSync(old);
    for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < "012"))
      writeFileSync(join(old, f), readFileSync(new URL(f, MIGRATIONS)));
    const path = join(dir, "main.sqlite");
    let db = openDatabase(path, pathToFileURL(old + "/"));
    db.transaction(() => {
      db.prepare("INSERT INTO workers(worker_id,boot_id,ledger_id,last_seen) VALUES('w','b','l',0)").run();
      db.prepare("INSERT INTO worker_slots VALUES('w','child')").run();
      db.prepare("INSERT INTO sessions(session_id,kind) VALUES('m','main')").run();
      db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path) VALUES('s','worker','w','repo',1,'r','/tmp')").run();
      db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,state,created_at) VALUES('parent','m','p','h','waiting_children',1)").run();
      db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,worker_id,queue_seq,state,parent_job_id,delegation_id,created_at) VALUES('child','s','c','h','w',7,'running','parent','d',2)").run();
      db.prepare("INSERT INTO runtime_turns VALUES('child','t','{}','f',3)").run();
      db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('child','t','c-1',1,'h1','bash','{}','completed')").run();
      db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('child','t','c-2',2,'h2','bash','{}','dispatched')").run();
    })();
    const before = inspect(path);
    db.close();
    db = openDatabase(path);
    db.close();
    const after = inspect(path);
    assert.equal(after.schema, "013_enrollment.sql");
    const { schema: _a, ...kept } = after, { schema: _b, ...was } = before;
    assert.deepEqual(kept, was);
    assert.deepEqual([after.unsettled_calls, after.call_seq_watermark, after.queue_seq_watermark, after.waiting_parents, after.open_children], [1, 2, 7, 1, 1]);
    const copies = readdirSync(dir).filter((f) => f.startsWith("pre-migrate-011_session_context-"));
    assert.equal(copies.length, 1, "the database as it was is kept before migrating");
    assert.equal(inspect(join(dir, copies[0])).schema, "011_session_context.sql");
    // Nothing is copied when nothing is migrated.
    openDatabase(path).close();
    assert.equal(readdirSync(dir).filter((f) => f.startsWith("pre-migrate-")).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P7-A a revoked token is replaced through token_file without restarting the worker", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { work: bash("work-1", "echo work >> marker.log") } });
  try {
    const issue = async () => (await s.api("POST", "/api/worker-tokens", { worker_id: "w" })).json() as { token: string; token_id: string };
    const first = await issue();
    const file = join(s.dir, "w.token");
    writeFileSync(file, first.token, { mode: 0o600 });
    s.startWorker({ env: { WORKER_TOKEN: undefined as unknown as string }, extraConfig: `token_file = "${file}"\n` });
    await s.ready();
    const list = async () => (await s.api("GET", "/api/worker-tokens")).json() as Array<{ token_id: string; worker_id: string; revoked_at: number | null; in_use: boolean }>;
    assert.ok(!JSON.stringify(await list()).includes(first.token), "the list never carries a token");
    assert.equal((await list()).find((t) => t.in_use)?.token_id, first.token_id);

    const second = await issue();
    writeFileSync(file, second.token, { mode: 0o600 });
    const epoch = s.one("SELECT connection_epoch FROM workers").connection_epoch;
    assert.equal((await s.api("POST", "/api/worker-tokens/revoke", { token_id: first.token_id })).statusCode, 200);
    await s.until(() => s.one("SELECT connection_epoch FROM workers").connection_epoch > epoch);
    await s.ready();
    assert.equal(s.worker!.child.exitCode, null, "the worker reconnected with the new token");
    const tokens = await list();
    assert.equal(tokens.find((t) => t.token_id === second.token_id)?.in_use, true);
    assert.ok(tokens.find((t) => t.token_id === first.token_id)?.revoked_at);
    assert.equal((await s.api("POST", "/api/worker-tokens/revoke", { token_id: "0".repeat(16) })).statusCode, 404);
    const job = await s.submit(await s.createSession(), "work");
    await s.until(() => s.state(job) === "succeeded");
    assert.equal(s.count("work"), 1);
  } finally { await s.close(); }
});

test("P7-A retention removes old output, Pi session files and expired logins; a full disk pauses dispatch", { timeout: 60000 }, async () => {
  let free = 10_000;
  const s = await startScenario({
    scripts: { noisy: bash("noisy-1", "echo noisy >> marker.log; seq 1 2000"), again: bash("again-1", "echo again >> marker.log") },
    app: { retentionMs: 0, minFreeBytes: 1000, maintenanceMs: 100, freeBytes: () => free },
  });
  try {
    s.startWorker(); await s.ready();
    const job = await s.submit(await s.createSession(), "noisy");
    await s.until(() => s.state(job) === "succeeded");
    await s.until(() => s.one("SELECT COUNT(*) n FROM call_log_state WHERE pruned_at IS NULL").n === 0);
    assert.equal(s.one("SELECT COUNT(*) n FROM call_logs").n, 0);
    const log = (await s.api("GET", `/api/jobs/${job}/calls/noisy-1/logs`)).json();
    assert.ok(log.pruned_at && log.items.length === 0 && log.gaps.length === 1, JSON.stringify(log));
    // The committed result still carries what the model saw.
    assert.match(s.one("SELECT result_json FROM runtime_calls WHERE call_id='noisy-1'").result_json, /2000/);
    await s.until(() => !existsSync(join(s.dir, "data", "pi-sessions", s.one("SELECT session_id FROM jobs WHERE job_id=?", job).session_id)));
    s.main.db.prepare("INSERT INTO auth_sessions VALUES ('expired','c',1)").run();
    await s.until(() => s.one("SELECT 1 FROM auth_sessions WHERE digest='expired'") === undefined);

    free = 10;
    await s.until(() => s.one("SELECT reason FROM dispatch_state").reason === "disk_low");
    assert.equal((await health(s)).scheduling_ready, false);
    assert.equal((await s.api("POST", "/api/ops/resume", { note: "ignore" })).json().error, "disk_low");
    const held = await s.submit(await s.createSession(), "again");
    await sleep(500);
    assert.equal(s.state(held), "queued");
    free = 10_000;
    await s.until(() => s.state(held) === "succeeded");
    assert.equal(s.one("SELECT paused FROM dispatch_state").paused, 0);
  } finally { await s.close(); }
});

test("P7-A SIGTERM stops a worker gracefully: the running command's process group ends with it", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { long: bash("long-1", "sleep 60 & echo $! > child.pid; wait") } });
  try {
    s.startWorker(); await s.ready();
    const job = await s.submit(await s.createSession(), "long");
    const pidFile = join(s.workspace, "child.pid");
    await s.until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const worker = s.worker!;
    worker.child.kill("SIGTERM");
    await worker.exited;
    assert.equal(worker.child.exitCode, 0, worker.stderr());
    assert.throws(() => process.kill(pid, 0), "the command did not outlive the worker");
    await s.stopWorker();
    s.startWorker();
    await s.until(() => ["failed", "succeeded", "needs_attention"].includes(s.state(job)));
    assert.equal(s.callStatus("long-1"), "completed", "the stopped command's result was kept and delivered");
  } finally { await s.close(); }
});

test("P7-A every route except health, login, session probe the worker socket and signed enrollment need a login", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false });
  try {
    await app.ready();
    const routes = new Set<string>();
    for (const line of app.printRoutes({ commonPrefix: false }).split("\n")) {
      const m = line.match(/(\/\S*) \(([^)]+)\)/);
      if (m) for (const method of m[2].split(", ")) routes.add(`${method} ${m[1]}`);
    }
    const open = new Set(["GET /health", "HEAD /health", "POST /auth/login", "GET /auth/session", "HEAD /auth/session", "GET /ws/worker", "HEAD /ws/worker", "POST /enrollment/challenge", "POST /enrollment/apply", "POST /enrollment/status", "POST /enrollment/credentials", "POST /enrollment/workspace"]);
    assert.ok(routes.size > 25, [...routes].join("\n"));
    for (const route of routes) {
      if (open.has(route)) continue;
      const [method, path] = route.split(" ");
      const url = path.replace(/:[a-z_]+/g, "x");
      const res = await app.inject({ method: method as any, url, headers: { origin: "https://localhost:8443" }, payload: method === "GET" || method === "HEAD" ? undefined : {} });
      assert.equal(res.statusCode, 401, `${route} answered ${res.statusCode} without a login`);
    }
    assert.equal((await app.inject({ method: "GET", url: "/ws/worker" })).statusCode, 401, "the worker socket needs a worker token");
  } finally { await app.close(); db.close(); }
});

test("P7-A the Main runtime has no local execution tool; a model asking for one runs nothing", { timeout: 60000 }, async () => {
  assert.deepEqual([...ROLE_TOOLS.main], ["list_workers", "delegate", "get_job"]);
  const s = await startScenario({ scripts: { sneaky: [{ tool: "bash", arguments: { command: "echo main >> marker.log" }, id: "sneak-1" }, { text: "done" }] } });
  try {
    s.startWorker(); await s.ready();
    const mark = s.proxy.frames.length;
    const job = await s.submit(await mainSession(s), "sneaky");
    await s.until(() => ["succeeded", "failed"].includes(s.state(job)));
    assert.equal(s.count("main"), 0);
    assert.equal(s.proxy.frames.slice(mark).filter((f) => f.type === "tool_call").length, 0, "nothing reached a worker");
    const record = s.one("SELECT status,result_json FROM runtime_calls WHERE call_id='sneak-1'");
    if (record) assert.match(record.result_json, /unknown_tool|not found/i);
  } finally { await s.close(); }
});

test("P7-A the worker has no model client, model key or model setting", () => {
  const sources = readdirSync(join(repoRoot, "worker/src")).map((f) => readFileSync(join(repoRoot, "worker/src", f), "utf8"));
  sources.push(readFileSync(join(repoRoot, "worker/Cargo.toml"), "utf8"));
  for (const text of sources)
    assert.doesNotMatch(text, /openrouter|anthropic|openai|MODEL_|API_KEY|pi-ai|pi-coding-agent/i);
});

test("P7-A restore never leaves a half-written database or a stale WAL behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-restore-"));
  try {
    const live = join(dir, "main.sqlite");
    openDatabase(live).close();
    const copy = join(dir, "copy.sqlite");
    await backup(dir, copy);
    // A backup that cannot be migrated fails before the live database is touched.
    const broken = join(dir, "broken.sqlite");
    const b = openDatabase(broken);
    b.prepare("DELETE FROM schema_migrations WHERE version='012_p7_ops.sql'").run();
    b.close();
    assert.throws(() => restore(dir, broken));
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("main.sqlite")).sort(), ["main.sqlite"]);
    assert.equal(inspect(live).integrity, "ok");
    // A WAL left without its database (a crash mid-rename) moves aside too.
    rmSync(live);
    writeFileSync(`${live}-wal`, "stale");
    const restored = restore(dir, copy, 42);
    assert.equal(restored.replaced, `${live}.replaced-42`);
    assert.ok(existsSync(`${live}.replaced-42-wal`) && !existsSync(`${live}-wal`));
    assert.equal(inspect(live).integrity, "ok");
    assert.equal(readdirSync(dir).filter((f) => f.includes("restoring")).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P7-A a full disk at startup pauses before recovery starts anything", { timeout: 60000 }, async () => {
  let free = 10_000;
  const s = await startScenario({ scripts: { plan: [{ text: "main done" }] }, app: { minFreeBytes: 1000, maintenanceMs: 3600_000, freeBytes: () => free } });
  try {
    assert.equal((await s.api("POST", "/api/ops/pause", { note: "hold" })).statusCode, 200);
    const job = await s.submit(await mainSession(s), "plan");
    await s.stopMain();
    free = 10;
    const db = openDatabase(join(s.dir, "main.sqlite"));
    db.prepare("UPDATE dispatch_state SET paused=0,reason=NULL,note=NULL,since=NULL").run();
    db.close();
    await s.startMain();
    await sleep(1000);
    assert.equal(s.one("SELECT reason FROM dispatch_state").reason, "disk_low");
    assert.equal(s.state(job), "queued", "the recovery pass did not start the queued Main job");
  } finally { await s.close(); }
});
