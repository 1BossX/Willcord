// P3-C acceptance: the main node runs as its own process and is SIGKILLed at
// each commit point. Recovery must come from SQLite alone, without asking the
// model again or repeating the worker side effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { openDatabase } from "../src/storage.js";
import type { MainFaultPoint } from "../src/fault.js";
import { createCertificates, startTlsProxy, startWorker, stopWorker, waitFor, type WorkerProcess } from "./support/worker-harness.js";
import { adminClient, expectMainRefused, startMainProcess, type MainProcess } from "./support/main-process.js";

const token = "p3-main-process-worker-token";
const password = "p3-main-process-password";

async function processScenario() {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-p3c-main-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const certs = createCertificates(dir);
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  const scriptFile = join(dir, "scripts.json");
  writeFileSync(scriptFile, JSON.stringify({
    crash: [{ tool: "bash", arguments: { command: "echo crash >> marker.log; sleep 1" }, id: "crash-1" }, { text: "done" }],
    next: [{ tool: "bash", arguments: { command: "echo next >> marker.log" }, id: "next-1" }, { text: "done" }],
  }));
  // Seed credentials before the first start; the test keeps a reader on the same WAL database.
  const db = openDatabase(join(dataDir, "main.sqlite"));
  db.prepare("INSERT INTO worker_tokens VALUES (?,'w',NULL)").run(createHash("sha256").update(token).digest("hex"));
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash(password, { type: argon2.argon2id }));
  let main: MainProcess | undefined;
  let worker: WorkerProcess | undefined;
  const proxy = await startTlsProxy(certs, () => main!.port);
  const one = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as any;
  return {
    dataDir, scriptFile, proxy, one,
    get main() { return main!; },
    count: (tag: string) => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === tag).length : 0,
    start: async (env: Record<string, string> = {}) => (main = await startMainProcess({ dataDir, scriptFile, env })),
    startWorker: () => (worker = startWorker({ dir, id: "w", url: proxy.url, ca: certs.ca, token, workspace })),
    until: (check: () => boolean, timeoutMs = 20000) => waitFor(() => {
      if (worker && worker.child.exitCode !== null) throw new Error(`worker exited: ${worker.stderr()}`);
      return check();
    }, timeoutMs),
    close: async () => {
      if (worker) await stopWorker(worker);
      if (main && main.child.exitCode === null && main.child.signalCode === null) { main.child.kill("SIGTERM"); await main.exited; }
      await proxy.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

for (const point of ["before_dispatch", "after_dispatch", "after_result_commit"] satisfies MainFaultPoint[]) {
  test(`P3-C main process SIGKILL ${point}: restart resumes from SQLite without repeating the model turn or the effect`, { timeout: 90000 }, async (t) => {
    const s = await processScenario();
    try {
      await s.start({ WP_MAIN_FAULT: point });
      s.startWorker();
      await s.until(() => s.one("SELECT reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
      const post = await adminClient(() => s.main.port, password);
      const session = (await (await post("/api/sessions", { worker_id: "w", workspace_id: "repo" })).json()).session_id;
      const job = (await (await post(`/api/sessions/${session}/messages`, { client_request_id: "crash", message: "crash" })).json()).job_id;
      t.diagnostic(`job=${job} call=crash-1`);

      const killed = s.main;
      await killed.exited;
      assert.equal(killed.child.signalCode, "SIGKILL");
      assert.match(killed.stderr(), new RegExp(`fault injection: SIGKILL at ${point}`));
      const status = s.one("SELECT status FROM runtime_calls WHERE call_id='crash-1'").status;
      assert.equal(status, { before_dispatch: "committed", after_dispatch: "dispatched", after_result_commit: "completed" }[point]);

      // The owner lock fails closed after an unclean exit until an operator clears it.
      const refused = await expectMainRefused({ dataDir: s.dataDir, scriptFile: s.scriptFile });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /EEXIST/);
      rmSync(join(s.dataDir, "main.lock"), { recursive: true });

      await s.start();
      await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", job).state === "succeeded");
      assert.equal(s.count("crash"), 1, "one side effect");
      assert.equal(s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", job).n, 1, "the tool turn was not regenerated");
      assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"tool\"%'", job).n, 1, "one tool message");
      assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"assistant\"%'", job).n, 1, "one final answer");
      assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
      // The slot is released right after the job settles, but a tick later than
      // the state flip; wait for it instead of racing the coordinator.
      await s.until(() => s.one("SELECT active_job_id FROM worker_slots").active_job_id === null);
      if (point === "after_result_commit")
        assert.ok(s.proxy.frames.filter((f) => f.type === "tool_ack" && f.call_id === "crash-1").length >= 1, "the lost ACK was sent after restart");

      const repost = await adminClient(() => s.main.port, password);
      const next = (await (await repost(`/api/sessions/${session}/messages`, { client_request_id: "next", message: "next" })).json()).job_id;
      await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", next).state === "succeeded");
      assert.equal(s.count("crash"), 1);
      assert.equal(s.count("next"), 1);
    } finally { await s.close(); }
  });
}

test("P3-C a second main process on the same data directory is refused while the first keeps serving", { timeout: 60000 }, async (t) => {
  const s = await processScenario();
  try {
    const first = await s.start();
    t.diagnostic(`first pid=${first.child.pid}`);
    const second = await expectMainRefused({ dataDir: s.dataDir, scriptFile: s.scriptFile });
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /EEXIST/);
    assert.ok((await fetch(`http://127.0.0.1:${first.port}/health`)).ok, "the first instance still serves");
    assert.equal(JSON.parse(readFileSync(join(s.dataDir, "main.lock/owner.json"), "utf8")).pid, first.child.pid, "the lock still names the first instance");
    first.child.kill("SIGTERM");
    await first.exited;
    assert.equal(existsSync(join(s.dataDir, "main.lock")), false, "a clean shutdown releases the lock");
    await s.start();
  } finally { await s.close(); }
});
