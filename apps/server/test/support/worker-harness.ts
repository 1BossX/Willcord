// Real Rust worker processes behind a verified TLS endpoint, for ledger and
// fault tests. The certificate chain mirrors the Caddy deployment.
import { createServer, type Server } from "node:https";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

export const repoRoot = resolve(import.meta.dirname, "../../../..");

export const waitFor = async (check: () => boolean, timeoutMs = 10000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

export function createCertificates(dir: string) {
  const file = (name: string) => join(dir, name);
  const openssl = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca-key.pem"), "-out", file("ca.pem"), "-days", "1", "-subj", "/CN=Worker Plane Test CA", "-addext", "basicConstraints=critical,CA:TRUE"]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", file("key.pem"), "-out", file("cert.csr"), "-subj", "/CN=localhost"]);
  writeFileSync(file("cert.ext"), "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n");
  openssl(["x509", "-req", "-in", file("cert.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-CAcreateserial", "-out", file("cert.pem"), "-days", "1", "-extfile", file("cert.ext")]);
  return { ca: file("ca.pem"), key: file("key.pem"), cert: file("cert.pem") };
}

/** A TLS WebSocket endpoint whose connections are handed to the test. */
export async function startTlsEndpoint(certs: ReturnType<typeof createCertificates>, onConnection: (socket: WebSocket) => void) {
  const server: Server = createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) });
  const wss = new WebSocketServer({ server, maxPayload: 65536 });
  wss.on("connection", onConnection);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    url: `wss://localhost:${port}/ws/worker`,
    dropAll: () => { for (const client of wss.clients) client.terminate(); },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export type WorkerProcess = { child: ChildProcess; stderr: () => string; exited: Promise<unknown> };

export function startWorker(options: { dir: string; id: string; url: string; ca: string; token: string; workspace: string; binary?: string; env?: Record<string, string>; retentionSecs?: number; configVersion?: number }): WorkerProcess {
  const config = join(options.dir, `${options.id}.toml`);
  mkdirSync(options.workspace, { recursive: true });
  writeFileSync(
    config,
    `worker_id = "${options.id}"\ndata_dir = "${options.dir}/${options.id}-data"\nurl = "${options.url}"\n` +
      (options.retentionSecs === undefined ? "" : `result_retention_secs = ${options.retentionSecs}\n`) +
      `[[workspaces]]\nworkspace_id = "repo"\nconfig_version = ${options.configVersion ?? 1}\npath = "${options.workspace}"\nrepo_id = "github.com/1BossX/WorkerPlane"\nis_default = true\n`,
  );
  const child = spawn(options.binary ?? join(repoRoot, "worker/target/debug/worker-plane-worker"), [config], {
    env: { ...process.env, WORKER_TOKEN: options.token, SSL_CERT_FILE: options.ca, ...options.env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  return { child, stderr: () => stderr, exited: once(child, "exit") };
}

/**
 * The worker built with test-only SIGKILL points (WP_FAULT). It lives in its own
 * target directory so the default debug binary used by other tests is untouched.
 */
export function buildFaultWorker() {
  const targetDir = join(repoRoot, "worker/target/fault");
  execFileSync("cargo", ["build", "--locked", "--quiet", "--manifest-path", join(repoRoot, "worker/Cargo.toml"), "--features", "fault-injection", "--target-dir", targetDir], { stdio: "inherit" });
  return join(targetDir, "debug/worker-plane-worker");
}

/** Stop a worker; a signal it ignores fails the test instead of hanging it. */
export async function stopWorker(worker: WorkerProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill(signal);
    const exited = await Promise.race([worker.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 10000))]);
    if (!exited) {
      worker.child.kill("SIGKILL");
      await worker.exited;
      throw new Error(`worker ignored ${signal}: ${worker.stderr()}`);
    }
  }
}

export type Direction = "to_main" | "to_worker";
export type RelayedFrame = { direction: Direction; type: string; call_id?: string; dropped: boolean };

/**
 * TLS termination in front of the main node, standing in for Caddy. The target
 * port is read per connection so a restarted main node is reached at its new
 * port; dropAll() simulates a network loss without restarting either side.
 * `drop` loses individual frames on an otherwise healthy connection; every
 * relayed frame is recorded in `frames` as evidence.
 */
export async function startTlsProxy(certs: ReturnType<typeof createCertificates>, target: () => number, options: { drop?: (direction: Direction, frame: any) => boolean } = {}) {
  const frames: RelayedFrame[] = [];
  const relay = (direction: Direction, to: WebSocket, data: string) => {
    const frame = JSON.parse(data);
    const dropped = options.drop?.(direction, frame) ?? false;
    if (frame.type !== "heartbeat") frames.push({ direction, type: frame.type, call_id: frame.call_id, dropped });
    if (!dropped) to.send(data);
  };
  const server: Server = createServer({ key: readFileSync(certs.key), cert: readFileSync(certs.cert) });
  const gateway = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const pairs = new Set<{ client: WebSocket; upstream: WebSocket }>();
  server.on("upgrade", (req, socket, head) => {
    const upstream = new WebSocket(`ws://127.0.0.1:${target()}${req.url}`, { headers: { authorization: req.headers.authorization ?? "" } });
    upstream.on("unexpected-response", (_req, res) => socket.end(`HTTP/1.1 ${res.statusCode} Unauthorized\r\nConnection: close\r\n\r\n`));
    upstream.on("error", () => socket.destroy());
    upstream.on("open", () =>
      gateway.handleUpgrade(req, socket, head, (client) => {
        const pair = { client, upstream };
        pairs.add(pair);
        client.on("message", (data) => relay("to_main", upstream, data.toString()));
        upstream.on("message", (data) => relay("to_worker", client, data.toString()));
        client.on("close", () => { pairs.delete(pair); upstream.close(); });
        upstream.on("close", (code, reason) => { pairs.delete(pair); if (code === 1005 || code === 1006) client.terminate(); else client.close(code, reason); });
        client.on("error", () => upstream.terminate());
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return {
    url: `wss://localhost:${port}/ws/worker`,
    frames,
    dropAll: () => { for (const { client, upstream } of pairs) { client.terminate(); upstream.terminate(); } },
    close: async () => {
      for (const { client, upstream } of pairs) { client.terminate(); upstream.terminate(); }
      gateway.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
