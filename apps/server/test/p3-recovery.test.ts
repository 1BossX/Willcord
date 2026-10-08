import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { requestHash } from "@worker-plane/protocol";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import type { ScriptStep } from "../src/execution.js";
import { createCertificates, startTlsProxy, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";

const origin = "https://localhost:8443";
const token = "p3-recovery-worker-token";

/** Each job's scripted model turns, keyed by the user message. */
const scripts: Record<string, ScriptStep[]> = {
  "network loss": [{ tool: "bash", arguments: { command: "sleep 2; echo net >> marker.log" }, id: "net-1" }, { text: "done" }],
  "main restart": [{ tool: "bash", arguments: { command: "sleep 2; echo restart >> marker.log" }, id: "restart-1" }, { text: "done" }],
  "committed before dispatch": [{ tool: "bash", arguments: { command: "echo precommitted >> marker.log" }, id: "pre-1" }, { text: "done" }],
  "worker crash": [{ tool: "bash", arguments: { command: "echo crash >> marker.log; sleep 30" }, id: "crash-1" }, { text: "done" }],
  "after block": [{ tool: "bash", arguments: { command: "echo blocked >> marker.log" }, id: "block-1" }, { text: "done" }],
};

test("P3 main node keeps in-flight calls across network loss, main restart and worker crash without repeating side effects", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-p3-"));
  const certs = createCertificates(dir);
  const dbPath = join(dir, "main.sqlite");
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  const count = (tag: string) => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === tag).length : 0;
  let main: { db: ReturnType<typeof openDatabase>; app: Awaited<ReturnType<typeof createApp>>; port: number } | undefined;
  const startMain = async () => {
    const db = openDatabase(dbPath);
    const app = await createApp(db, origin, { logging: false, dataDir: join(dir, "data"), fakeScript: (job) => scripts[job.input_text] });
    await app.listen({ host: "127.0.0.1", port: 0 });
    main = { db, app, port: (app.server.address() as { port: number }).port };
    return main;
  };
  const stopMain = async () => { await main!.app.close(); main!.db.close(); main = undefined; };
  const one = (sql: string, ...params: unknown[]) => main!.db.prepare(sql).get(...params) as any;
  let worker: WorkerProcess | undefined;
  const until = (check: () => boolean, timeoutMs = 20000) => waitFor(() => {
    if (worker && worker.child.exitCode !== null) throw new Error(`worker exited: ${worker.stderr()}`);
    return check();
  }, timeoutMs);
  const proxy = await startTlsProxy(certs, () => main!.port);
  const start = () => (worker = startWorker({ dir, id: "w", url: proxy.url, ca: certs.ca, token, workspace }));
  try {
    await startMain();
    main!.db.prepare("INSERT INTO worker_tokens VALUES (?,'w',NULL)").run(createHash("sha256").update(token).digest("hex"));
    main!.db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash("p3-recovery-password", { type: argon2.argon2id }));
    const login = await main!.app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { password: "p3-recovery-password" } });
    const headers = { cookie: login.headers["set-cookie"]!.toString().split(";")[0], origin, "x-csrf-token": login.json().csrf };
    start();
    await until(() => one("SELECT online,reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
    const session = (await main!.app.inject({ method: "POST", url: "/api/sessions", headers, payload: { worker_id: "w", workspace_id: "repo" } })).json().session_id;
    const submit = async (message: string) => {
      const response = await main!.app.inject({ method: "POST", url: `/api/sessions/${session}/messages`, headers, payload: { client_request_id: message, message } });
      assert.ok([200, 202].includes(response.statusCode), response.body);
      return response.json().job_id as string;
    };
    const state = (jobId: string) => one("SELECT state FROM jobs WHERE job_id=?", jobId).state;
    const callStatus = (callId: string) => one("SELECT status FROM runtime_calls WHERE call_id=?", callId)?.status;

    // 1. The network drops while the command runs: the call is kept and finishes once.
    const epoch = one("SELECT connection_epoch FROM workers").connection_epoch;
    const net = await submit("network loss");
    await until(() => callStatus("net-1") === "dispatched");
    proxy.dropAll();
    await until(() => state(net) === "succeeded");
    assert.equal(count("net"), 1);
    assert.ok(one("SELECT connection_epoch FROM workers").connection_epoch > epoch, "the call finished on a new connection");
    assert.equal(one("SELECT blocked FROM workers").blocked, 0);
    assert.equal(one("SELECT active_job_id FROM worker_slots").active_job_id, null);

    // 2. The main node restarts after dispatch: it resumes from SQLite without asking the model again.
    const restart = await submit("main restart");
    await until(() => callStatus("restart-1") === "dispatched");
    await stopMain();
    await startMain();
    await until(() => state(restart) === "succeeded");
    assert.equal(count("restart"), 1);
    assert.equal(one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", restart).n, 1, "the tool turn was not regenerated");
    assert.equal(one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"assistant\"%'", restart).n, 1);
    assert.equal(one("SELECT blocked FROM workers").blocked, 0);

    // 3. The main node died after committing an intent but before sending it.
    await stopWorker(worker!, "SIGINT");
    worker = undefined;
    await until(() => one("SELECT online FROM workers").online === 0);
    const pre = await submit("committed before dispatch");
    assert.equal(state(pre), "waiting_worker");
    await stopMain();
    {
      const db = openDatabase(dbPath);
      const command = "echo precommitted >> marker.log";
      const assistant = { role: "assistant", content: [{ type: "toolCall", id: "pre-1", name: "bash", arguments: { command } }], api: "openai-completions", provider: "openai", model: "gpt-4o-mini", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() };
      const hash = requestHash({ worker_id: "w", job_id: pre, call_id: "pre-1", call_seq: 1, workspace_id: "repo", config_version: 1, tool: "bash", arguments: { command } });
      db.transaction(() => {
        db.prepare("UPDATE worker_slots SET active_job_id=? WHERE worker_id='w'").run(pre);
        db.prepare("UPDATE jobs SET state='running',started_at=? WHERE job_id=?").run(Date.now(), pre);
        db.prepare("INSERT INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)").run(pre, `user:${pre}`, JSON.stringify({ role: "user", content: [{ type: "text", text: "committed before dispatch" }], timestamp: Date.now() }));
        db.prepare("INSERT INTO runtime_turns VALUES(?,?,?,?,?)").run(pre, "turn-pre", JSON.stringify(assistant), "fingerprint", Date.now());
        db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES(?,?,?,?,?,?,?,'committed')").run(pre, "turn-pre", "pre-1", 1, hash, "bash", JSON.stringify({ command }));
        db.prepare("INSERT INTO runtime_history(job_id,entry_key,turn_key) VALUES(?,?,?)").run(pre, "turn:turn-pre", "turn-pre");
      })();
      db.close();
    }
    await startMain();
    start();
    await until(() => state(pre) === "succeeded");
    assert.equal(count("precommitted"), 1);
    assert.equal(one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", pre).n, 1);

    // 4. The worker is killed after the side effect: execution cannot be proven, so it blocks.
    const crash = await submit("worker crash");
    await until(() => count("crash") === 1);
    await stopWorker(worker!);
    start();
    await until(() => state(crash) === "needs_attention");
    await until(() => one("SELECT blocked FROM workers").blocked === 1);
    assert.equal(callStatus("crash-1"), "unknown");
    assert.equal(one("SELECT active_job_id FROM worker_slots").active_job_id, crash, "the slot is kept");
    assert.match(one("SELECT evidence FROM attention_actions WHERE job_id=?", crash).evidence, /worker_reports_unknown_execution/);
    const blocked = await submit("after block");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(state(blocked), "waiting_worker");
    assert.equal(callStatus("block-1"), undefined, "a blocked worker gets no new work");
    assert.equal(count("crash"), 1);
    assert.equal(count("blocked"), 0);
  } finally {
    if (worker) await stopWorker(worker);
    if (main) await stopMain();
    await proxy.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
