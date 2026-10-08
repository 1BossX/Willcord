// An in-process main node (Fastify + SQLite file + scripted Pi) behind the TLS
// proxy, with a real Rust worker. Each fault scenario gets its own directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { openDatabase } from "../../src/storage.js";
import { createApp } from "../../src/app.js";
import type { ScriptStep } from "../../src/execution.js";
import { createCertificates, startTlsProxy, startWorker, stopWorker, waitFor, type Direction, type WorkerProcess } from "./worker-harness.js";

export const origin = "https://localhost:8443";
export const workerToken = "p3-fault-worker-token";
const password = "p3-fault-admin-password";

type AppOptions = Parameters<typeof createApp>[2];

export async function startScenario(options: {
  scripts: Record<string, ScriptStep[]>;
  drop?: (direction: Direction, frame: any) => boolean;
  app?: AppOptions;
}) {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-p3c-"));
  const certs = createCertificates(dir);
  const dbPath = join(dir, "main.sqlite");
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  let main: { db: ReturnType<typeof openDatabase>; app: Awaited<ReturnType<typeof createApp>>; port: number } | undefined;
  let worker: WorkerProcess | undefined;
  const startMain = async () => {
    const db = openDatabase(dbPath);
    const app = await createApp(db, origin, { logging: false, dataDir: join(dir, "data"), fakeScript: (job) => options.scripts[job.input_text], ...options.app });
    await app.listen({ host: "127.0.0.1", port: 0 });
    main = { db, app, port: (app.server.address() as { port: number }).port };
  };
  const stopMain = async () => { await main!.app.close(); main!.db.close(); main = undefined; };
  const proxy = await startTlsProxy(certs, () => main!.port, { drop: options.drop });
  await startMain();
  main!.db.prepare("INSERT INTO worker_tokens VALUES (?,'w',NULL)").run(createHash("sha256").update(workerToken).digest("hex"));
  main!.db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash(password, { type: argon2.argon2id }));
  const login = await main!.app.inject({ method: "POST", url: "/auth/login", headers: { origin }, payload: { password } });
  const headers = { cookie: login.headers["set-cookie"]!.toString().split(";")[0], origin, "x-csrf-token": login.json().csrf };

  const one = (sql: string, ...params: unknown[]) => main!.db.prepare(sql).get(...params) as any;
  const all = (sql: string, ...params: unknown[]) => main!.db.prepare(sql).all(...params) as any[];
  const until = (check: () => boolean, timeoutMs = 20000) => waitFor(() => {
    if (worker && worker.child.exitCode !== null && worker.child.signalCode === null) throw new Error(`worker exited: ${worker.stderr()}`);
    return check();
  }, timeoutMs);
  const s = {
    dir, workspace, proxy,
    get main() { return main!; },
    get worker() { return worker; },
    startMain, stopMain, one, all, until,
    /** Lines in the workspace marker file equal to `tag`: the side-effect count. */
    count: (tag: string) => existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter((l) => l === tag).length : 0,
    startWorker: (extra: { binary?: string; env?: Record<string, string>; configVersion?: number } = {}) =>
      (worker = startWorker({ dir, id: "w", url: proxy.url, ca: certs.ca, token: workerToken, workspace, ...extra })),
    stopWorker: async (signal: NodeJS.Signals = "SIGKILL") => { if (worker) await stopWorker(worker, signal); worker = undefined; },
    ready: () => until(() => { const w = one("SELECT online,reconciled FROM workers WHERE worker_id='w'"); return w?.online === 1 && w?.reconciled === 1; }),
    createSession: async () => {
      const response = await main!.app.inject({ method: "POST", url: "/api/sessions", headers, payload: { worker_id: "w", workspace_id: "repo" } });
      assert.equal(response.statusCode, 201, response.body);
      return response.json().session_id as string;
    },
    post: (session: string, message: string) =>
      main!.app.inject({ method: "POST", url: `/api/sessions/${session}/messages`, headers, payload: { client_request_id: message, message } }),
    submit: async (session: string, message: string) => {
      const response = await s.post(session, message);
      assert.ok([200, 202].includes(response.statusCode), response.body);
      return response.json().job_id as string;
    },
    state: (jobId: string) => one("SELECT state FROM jobs WHERE job_id=?", jobId).state as string,
    callStatus: (callId: string) => one("SELECT status FROM runtime_calls WHERE call_id=?", callId)?.status as string | undefined,
    close: async () => {
      if (worker) await stopWorker(worker);
      if (main) await stopMain();
      await proxy.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return s;
}
