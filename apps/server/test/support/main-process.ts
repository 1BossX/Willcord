// The main node as its own OS process (src/main.ts), so it can be SIGKILLed at
// a commit point and restarted against the same data directory and lock.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { openDatabase } from "../../src/storage.js";
import { createCertificates, repoRoot, startTlsProxy, startWorker, stopWorker, waitFor, type WorkerProcess } from "./worker-harness.js";

export type MainProcess = { child: ChildProcess; port: number; stderr: () => string; exited: Promise<unknown> };

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

type MainOptions = { dataDir: string; scriptFile: string; env?: Record<string, string> };

async function spawnMain(options: MainOptions): Promise<MainProcess> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], {
    cwd: join(repoRoot, "apps/server"),
    env: { ...process.env, DATA_DIR: options.dataDir, PORT: String(port), PUBLIC_BASE_URL: "https://localhost:8443", P3_FAKE_SCRIPT_FILE: options.scriptFile, ...options.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  return { child, port, stderr: () => stderr, exited: once(child, "exit") };
}

/** Spawn the main node; resolves once it serves /health or rejects with its stderr if it exits. */
export async function startMainProcess(options: MainOptions): Promise<MainProcess> {
  // freePort() releases its probe before the child binds, so a concurrently
  // running test file can take the port first; that start is simply retried.
  for (let attempt = 1; ; attempt++) {
    const main = await spawnMain(options);
    const { child, port } = main;
    let healthy = false;
    try {
      await waitFor(() => {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`main exited (${child.exitCode ?? child.signalCode}): ${main.stderr()}`);
        fetch(`http://127.0.0.1:${port}/health`).then((r) => { healthy = r.ok; }, () => {});
        return healthy;
      }, 20000);
      return main;
    } catch (error) {
      if (attempt >= 5 || !main.stderr().includes("EADDRINUSE")) throw error;
    }
  }
}

/** Start a main node that must refuse to run; returns its exit code and stderr. */
export async function expectMainRefused(options: MainOptions) {
  const main = await spawnMain(options);
  const [code] = (await main.exited) as [number | null];
  return { code, stderr: main.stderr() };
}

/** A browser-like administrator client against a main process port. */
export async function adminClient(port: () => number, password: string) {
  const origin = "https://localhost:8443";
  const login = await fetch(`http://127.0.0.1:${port()}/auth/login`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], origin, "x-csrf-token": (await login.json()).csrf, "content-type": "application/json" };
  return (path: string, body: unknown) => fetch(`http://127.0.0.1:${port()}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
}

const token = "p3-main-process-worker-token";
const password = "p3-main-process-password";

/** A main process, its data directory, a TLS proxy and a real worker; `one` reads the live WAL database. */
export async function processScenario(scripts: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-p3c-main-"));
  const dataDir = join(dir, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const certs = createCertificates(dir);
  const workspace = join(dir, "workspace");
  const marker = join(workspace, "marker.log");
  const scriptFile = join(dir, "scripts.json");
  writeFileSync(scriptFile, JSON.stringify(scripts));
  // Seed credentials before the first start; the test keeps a reader on the same WAL database.
  const db = openDatabase(join(dataDir, "main.sqlite"));
  db.prepare("INSERT INTO worker_tokens VALUES (?,'w',NULL)").run(createHash("sha256").update(token).digest("hex"));
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(await argon2.hash(password, { type: argon2.argon2id }));
  let main: MainProcess | undefined;
  let worker: WorkerProcess | undefined;
  const proxy = await startTlsProxy(certs, () => main!.port);
  const one = (sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as any;
  return {
    dir, workspace, dataDir, scriptFile, proxy, one, password,
    get worker() { return worker; },
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
