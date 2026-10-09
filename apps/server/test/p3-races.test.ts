// P3-C acceptance for races that need exact frame ordering: a scripted worker
// speaks the protocol to an in-process main node with a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { WebSocket } from "ws";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import type { ScriptStep } from "../src/execution.js";
import { waitFor } from "./support/worker-harness.js";

const origin = "https://localhost:8443";
const token = "p3-race-worker-token";
const workspace = (version: number) => ({ workspace_id: "repo", config_version: version, path: `/tmp/p3-race-v${version}`, repo_id: "github.com/1BossX/WorkerPlane", is_default: true });

/** One worker connection; every frame received is kept in order. */
class ScriptedWorker {
  received: any[] = [];
  epoch = 0;
  private waiters: Array<() => void> = [];
  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => { this.received.push(JSON.parse(raw.toString())); for (const w of this.waiters.splice(0)) w(); });
  }
  static async connect(port: number) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, { headers: { authorization: `Bearer ${token}` } });
    await once(socket, "open");
    return new ScriptedWorker(socket);
  }
  send(frame: { type: string } & Record<string, unknown>) {
    // A register frame carries no epoch; the main node assigns one.
    const epoch = frame.type === "register" ? {} : { connection_epoch: this.epoch };
    this.socket.send(JSON.stringify({ protocol_version: 1, worker_id: "w", ...epoch, ...frame }));
  }
  async next(type: string, after = 0) {
    await waitFor(() => this.received.slice(after).some((f) => f.type === type)).catch((e) => { throw new Error(`no ${type}: ${JSON.stringify(this.received)}`, { cause: e }); });
    return this.received.slice(after).find((f) => f.type === type);
  }
  /** register → reconcile(calls) → worker_ready, as the Rust worker does. */
  async handshake(options: { version?: number; calls?: object[]; boot?: string } = {}) {
    const mark = this.received.length;
    this.send({ type: "register", boot_id: options.boot ?? "boot-1", ledger_id: "ledger-1", workspaces: [workspace(options.version ?? 1)] });
    this.epoch = (await this.next("register_ack", mark)).connection_epoch;
    const reconciled = this.received.length;
    this.send({ type: "reconcile", ledger_id: "ledger-1", ready: true, calls: options.calls ?? [] });
    await this.next("ack", reconciled);
    this.send({ type: "worker_ready", ready: true });
  }
  result(call: any, result: object) {
    this.send({ type: "tool_result", job_id: call.job_id, call_id: call.call_id, request_hash: call.request_hash, ok: true, result });
  }
}

async function raceScenario(scripts: Record<string, ScriptStep[]>, app: Parameters<typeof createApp>[2] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-p3c-race-"));
  const db = openDatabase(join(dir, "main.sqlite"));
  const main = await createApp(db, origin, { logging: false, dataDir: join(dir, "data"), fakeScript: (job) => scripts[job.input_text], ...app });
  await main.listen({ host: "127.0.0.1", port: 0 });
  const port = (main.server.address() as { port: number }).port;
  db.prepare("INSERT INTO worker_tokens VALUES (?,'w',NULL)").run(createHash("sha256").update(token).digest("hex"));
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash("p3-race-password", { type: argon2.argon2id }));
  const login = await main.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { password: "p3-race-password" } });
  const headers = { cookie: login.headers["set-cookie"]!.toString().split(";")[0], origin, "x-csrf-token": login.json().csrf };
  const one = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as any;
  const sockets: ScriptedWorker[] = [];
  return {
    db, one,
    connect: async () => { const w = await ScriptedWorker.connect(port); sockets.push(w); return w; },
    createSession: async () => (await main.inject({ method: "POST", url: "/api/sessions", headers, payload: { worker_id: "w", workspace_id: "repo" } })).json().session_id as string,
    post: (session: string, message: string) => main.inject({ method: "POST", url: `/api/sessions/${session}/messages`, headers, payload: { client_request_id: message, message } }),
    state: (jobId: string) => one("SELECT state FROM jobs WHERE job_id=?", jobId).state as string,
    close: async () => { for (const w of sockets) w.socket.terminate(); await main.close(); db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const call = (id: string): ScriptStep[] => [{ tool: "bash", arguments: { command: `echo ${id} >> marker.log` }, id }, { text: "done" }];
const settle = () => new Promise((r) => setTimeout(r, 300));

test("P3-C a late result on a replaced connection is not committed and the old connection gets no new call", { timeout: 30000 }, async (t) => {
  const s = await raceScenario({ race: call("race-1") });
  try {
    const old = await s.connect();
    await old.handshake();
    const session = await s.createSession();
    const job = (await s.post(session, "race")).json().job_id;
    t.diagnostic(`job=${job} call=race-1`);
    const sent = await old.next("tool_call");
    assert.equal(sent.connection_epoch, 1);

    const replacedAt = old.received.length;
    const replacement = await s.connect();
    const closed = once(old.socket, "close");
    await replacement.handshake({ calls: [] });
    // The old connection answers late, after the replacement registered.
    old.result(sent, { from: "old connection" });
    assert.equal((await closed)[0], 1008);
    await settle();
    assert.equal(s.one("SELECT status FROM runtime_calls WHERE call_id='race-1'").status, "dispatched", "a stale-epoch result is never committed");
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
    assert.equal(old.received.slice(replacedAt).filter((f) => f.type === "tool_call").length, 0, "the old connection receives no call after replacement");

    // The waiting call is re-sent on the new epoch only after it reconciled.
    const resent = await replacement.next("tool_call");
    assert.equal(resent.connection_epoch, 2);
    assert.equal(resent.request_hash, sent.request_hash);
    replacement.result(resent, { from: "new connection" });
    await waitFor(() => s.state(job) === "succeeded");
    assert.deepEqual(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='race-1'").result_json).result, { from: "new connection" });
    assert.equal((await replacement.next("tool_ack")).connection_epoch, 2);
  } finally { await s.close(); }
});

test("P3-C wait deadlines never release a slot whose call is unknown", { timeout: 30000 }, async (t) => {
  const previousWait = process.env.WORKER_WAIT_MS;
  process.env.WORKER_WAIT_MS = "200";
  const s = await raceScenario({ slow: call("slow-1"), later: call("later-1") }, { toolResultTimeoutMs: 300, waitSweepMs: 100 });
  try {
    const w = await s.connect();
    await w.handshake();
    const session = await s.createSession();
    const slow = (await s.post(session, "slow")).json().job_id;
    t.diagnostic(`job=${slow} call=slow-1`);
    const sent = await w.next("tool_call");
    // No result within the tool deadline: execution is unknown, not failed.
    await waitFor(() => s.state(slow) === "needs_attention");
    const unknownAt = w.received.length;
    assert.equal(s.one("SELECT status FROM runtime_calls WHERE call_id='slow-1'").status, "unknown");
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 1);
    assert.match(s.one("SELECT evidence FROM attention_actions WHERE job_id=?", slow).evidence, /tool_result_timeout/);

    // A queued job's wait deadline expires; the unknown job keeps the slot.
    const later = (await s.post(session, "later")).json().job_id;
    t.diagnostic(`expired job=${later}`);
    await waitFor(() => s.state(later) === "failed");
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, slow);
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=?", later).n, 0, "nothing was dispatched for the expired job");

    // The real result arrives after the deadline: recorded as a contradiction, no state regression.
    w.result(sent, { stdout: "late" });
    await settle();
    assert.equal(s.one("SELECT status FROM runtime_calls WHERE call_id='slow-1'").status, "unknown");
    assert.equal(s.state(slow), "needs_attention");
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, slow);
    assert.ok(s.one("SELECT 1 FROM attention_actions WHERE evidence LIKE '%result_for_unknown_call%'"));
    assert.equal(w.received.slice(unknownAt).filter((f) => f.type === "tool_call").length, 0, "an unknown call is never re-sent");
  } finally {
    if (previousWait === undefined) delete process.env.WORKER_WAIT_MS; else process.env.WORKER_WAIT_MS = previousWait;
    await s.close();
  }
});

test("P3-C a workspace version change never rebinds an in-flight job and never silently moves queued work", { timeout: 30000 }, async (t) => {
  const s = await raceScenario({ old: call("old-1"), current: call("current-1"), more: call("more-1") });
  try {
    const v1 = await s.connect();
    await v1.handshake({ version: 1 });
    const oldSession = await s.createSession();
    v1.socket.close();
    await waitFor(() => s.one("SELECT online FROM workers").online === 0);
    const queued = (await s.post(oldSession, "old")).json().job_id;
    assert.equal(s.state(queued), "waiting_worker");
    t.diagnostic(`version-1 job=${queued}`);

    // The worker returns with version 2: work bound to version 1 fails visibly instead of running elsewhere.
    const v2 = await s.connect();
    await v2.handshake({ version: 2 });
    await waitFor(() => s.state(queued) === "failed");
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=?", queued).n, 0);
    assert.match(s.one("SELECT content_json FROM events WHERE kind IS NULL ORDER BY event_id DESC").content_json, /workspace_version_changed/);
    const rejected = await s.post(oldSession, "more");
    assert.equal(rejected.statusCode, 409);
    assert.equal(rejected.json().error, "workspace_version_changed");
    const retried = await s.post(oldSession, "old");
    assert.equal(retried.statusCode, 200, "a retry of an accepted message still returns its job");
    assert.equal(retried.json().job_id, queued);

    // A new session binds version 2; while its call is in flight, version 3 is refused.
    const session = await s.createSession();
    assert.equal(s.one("SELECT workspace_version FROM sessions WHERE session_id=?", session).workspace_version, 2);
    const job = (await s.post(session, "current")).json().job_id;
    t.diagnostic(`version-2 job=${job} call=current-1`);
    const sent = await v2.next("tool_call");
    assert.equal(sent.config_version, 2);
    const v3 = await s.connect();
    const refused = once(v3.socket, "close");
    v3.send({ type: "register", boot_id: "boot-2", ledger_id: "ledger-1", workspaces: [workspace(3)] });
    assert.equal((await refused)[0], 1008);
    assert.equal(s.one("SELECT config_version FROM workspaces").config_version, 2);
    v2.result(sent, { stdout: "ok" });
    await waitFor(() => s.state(job) === "succeeded");
  } finally { await s.close(); }
});
