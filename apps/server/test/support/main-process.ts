// The main node as its own OS process (src/main.ts), so it can be SIGKILLed at
// a commit point and restarted against the same data directory and lock.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import { repoRoot, waitFor } from "./worker-harness.js";

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
  const main = await spawnMain(options);
  const { child, port } = main;
  let healthy = false;
  await waitFor(() => {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`main exited (${child.exitCode ?? child.signalCode}): ${main.stderr()}`);
    fetch(`http://127.0.0.1:${port}/health`).then((r) => { healthy = r.ok; }, () => {});
    return healthy;
  }, 20000);
  return main;
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
