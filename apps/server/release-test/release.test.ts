// P7-C release acceptance: the main node from a release directory
// (deploy/build-main.sh) and the release worker binary, installed and started
// the way the runbook does it: token issued through the API into a token file,
// the worker trusting only the deployment CA, both stopped with SIGTERM.
//
//   WP_RELEASE_DIR   release directory (required)
//   WP_WORKER_BIN    release worker binary (required)
//   CADDY_BIN        optional: put deploy/Caddyfile.production in front, with
//                    its internal CA, instead of the test TLS proxy, and hold
//                    WSS + SSE open through it for WP_LONG_SECS (default 75)
//
// The model is scripted: real-model runs are part of the guided acceptance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCertificates, startTlsProxy, waitFor } from "../test/support/worker-harness.js";

const releaseDir = process.env.WP_RELEASE_DIR;
const workerBin = process.env.WP_WORKER_BIN;
const caddyBin = process.env.CADDY_BIN;
const longSecs = Number(process.env.WP_LONG_SECS ?? 75);

async function freePort() {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

type Proc = { child: ChildProcess; log: () => string; exited: Promise<unknown> };
function run(cmd: string, args: string[], options: { cwd?: string; env: Record<string, string> }): Proc {
  const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  return { child, log: () => log, exited: once(child, "exit") };
}
async function stop(p: Proc | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return;
  p.child.kill(signal);
  await p.exited;
}

const bash = (id: string, command: string, extra: object = {}) => [{ tool: "bash", arguments: { command, ...extra }, id }, { text: `${id} done` }];
const scripts = {
  exec: bash("exec-1", "echo exec >> marker.log; uname -s"),
  timeout: bash("timeout-1", "sleep 30; echo late >> marker.log", { timeout_secs: 1 }),
  cancel: bash("cancel-1", "sleep 120 & echo $! > cancel.pid; wait"),
  "after worker restart": bash("restart-1", "echo after-worker-restart >> marker.log"),
  "across main restart": bash("main-restart-1", "echo across-main-restart >> marker.log"),
  "through caddy": bash("caddy-1", "echo through-caddy >> marker.log"),
};

test("P7-C release acceptance from the built artifacts", { timeout: 15 * 60_000 }, async (t) => {
  assert.ok(releaseDir && existsSync(join(releaseDir, "apps/server/dist/main.js")), "WP_RELEASE_DIR must point at a deploy/build-main.sh directory");
  assert.ok(workerBin && existsSync(workerBin), "WP_WORKER_BIN must point at the release worker binary");
  const dir = mkdtempSync(join(tmpdir(), "willcord-release-"));
  const dataDir = join(dir, "main-data");
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const marker = (tag: string) => existsSync(join(workspace, "marker.log")) ? readFileSync(join(workspace, "marker.log"), "utf8").split("\n").filter((l) => l === tag).length : 0;
  const scriptFile = join(dir, "scripts.json");
  writeFileSync(scriptFile, JSON.stringify(scripts));
  const password = `release-${Date.now()}-admin-password`;
  const mainPort = await freePort();
  let site: string, ca: string, wss: string;
  let caddy: Proc | undefined, proxy: Awaited<ReturnType<typeof startTlsProxy>> | undefined;
  if (caddyBin) {
    const sitePort = await freePort();
    site = `https://localhost:${sitePort}`;
    // The production Caddyfile, unchanged except that it proxies to this main port.
    const caddyfile = join(dir, "Caddyfile");
    writeFileSync(caddyfile, readFileSync(join(releaseDir, "deploy/Caddyfile.production"), "utf8"));
    caddy = run(caddyBin, ["run", "--config", caddyfile, "--adapter", "caddyfile"], { env: {
      PATH: process.env.PATH ?? "", HOME: dir, XDG_DATA_HOME: join(dir, "caddy-data"), XDG_CONFIG_HOME: join(dir, "caddy-config"),
      WILLCORD_SITE: `localhost:${sitePort}`, WILLCORD_PORT: String(sitePort), WILLCORD_ROOT: releaseDir,
      WILLCORD_WEB_ROOT: join(releaseDir, "apps/web/dist"), WILLCORD_UPSTREAM: `127.0.0.1:${mainPort}`,
      CADDY_ADMIN: `localhost:${await freePort()}`,
    } });
    ca = join(dir, "caddy-data/caddy/pki/authorities/local/root.crt");
    await waitFor(() => existsSync(ca), 30_000).catch(() => { throw new Error(`caddy did not create its CA: ${caddy!.log()}`); });
    wss = `wss://localhost:${sitePort}/ws/worker`;
  } else {
    const certs = createCertificates(dir);
    proxy = await startTlsProxy(certs, () => mainPort);
    site = "https://localhost:8443";
    ca = certs.ca;
    wss = proxy.url;
  }

  let main: Proc | undefined, worker: Proc | undefined;
  const startMain = async (extra: Record<string, string> = {}) => {
    main = run(process.execPath, ["dist/main.js"], { cwd: join(releaseDir, "apps/server"), env: {
      PATH: process.env.PATH ?? "", HOME: dir, DATA_DIR: dataDir, PORT: String(mainPort), PUBLIC_BASE_URL: site, P3_FAKE_SCRIPT_FILE: scriptFile, ...extra,
    } });
    let ready = false;
    await waitFor(() => {
      if (main!.child.exitCode !== null) throw new Error(`main exited: ${main!.log()}`);
      fetch(`http://127.0.0.1:${mainPort}/health`).then((r) => r.json()).then((h: any) => { ready = h.scheduling_ready; }, () => {});
      return ready;
    }, 30_000);
  };
  // The API as a browser sends it: Origin of the site, cookie and CSRF token.
  let headers: Record<string, string> = {};
  const api = async (method: string, path: string, body?: object) => {
    const r = await fetch(`http://127.0.0.1:${mainPort}${path}`, { method, headers: { ...headers, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, json: text ? JSON.parse(text) : null };
  };
  const tokenFile = join(dir, "worker-token");
  const workerConfig = join(dir, "worker.toml");
  writeFileSync(workerConfig, `worker_id = "release-w"\ndata_dir = "${join(dir, "worker-data")}"\nurl = "${wss}"\ntoken_file = "${tokenFile}"\nkill_grace_secs = 2\n[[workspaces]]\nworkspace_id = "repo"\nconfig_version = 1\npath = "${workspace}"\nrepo_id = "github.com/BossOptional/Willcord"\nis_default = true\n`);
  // As the systemd unit runs it: no token in the environment, only the deployment CA trusted.
  const startWorker = () => { worker = run(workerBin, [workerConfig], { env: { PATH: "/usr/bin:/bin", HOME: dir, SSL_CERT_FILE: ca } }); };
  const workerRow = async () => ((await api("GET", "/api/workers")).json as any[]).find((w) => w.worker_id === "release-w");
  const ready = () => waitFor(() => {
    if (worker!.child.exitCode !== null) throw new Error(`worker exited: ${worker!.log()}`);
    void workerRow().then((w) => { readyState = Boolean(w?.schedulable); }, () => {});
    return readyState;
  }, 30_000);
  let readyState = false;
  let session = "";
  const jobState = async (jobId: string) => ((await api("GET", `/api/sessions/${session}/jobs`)).json as any[]).find((j) => j.job_id === jobId)?.state as string | undefined;
  const untilState = async (jobId: string, states: string[], timeoutMs = 60_000) => {
    let current: string | undefined;
    await waitFor(() => { void jobState(jobId).then((s) => { current = s; }); return states.includes(current ?? ""); }, timeoutMs)
      .catch(() => { throw new Error(`job ${jobId} stayed ${current}; worker log: ${worker?.log().slice(-1500)}`); });
  };
  const submit = async (message: string) => {
    const r = await api("POST", `/api/sessions/${session}/messages`, { client_request_id: `${message}-${Date.now()}`, message });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    return r.json.job_id as string;
  };

  try {
    await t.test("install: first start with INITIAL_ADMIN_PASSWORD, login, token issued into a token file", async () => {
      await startMain({ INITIAL_ADMIN_PASSWORD: password });
      const login = await fetch(`http://127.0.0.1:${mainPort}/auth/login`, { method: "POST", headers: { origin: site, "content-type": "application/json" }, body: JSON.stringify({ password }) });
      assert.equal(login.status, 200);
      headers = { cookie: login.headers.get("set-cookie")!.split(";")[0], origin: site, "x-csrf-token": (await login.json()).csrf };
      const issued = await api("POST", "/api/worker-tokens", { worker_id: "release-w" });
      writeFileSync(tokenFile, issued.json.token, { mode: 0o600 });
      startWorker();
      await ready();
      const created = await api("POST", "/api/sessions", { worker_id: "release-w", workspace_id: "repo" });
      assert.equal(created.status, 201);
      session = created.json.session_id;
    });

    await t.test("execute", async () => {
      const job = await submit("exec");
      await untilState(job, ["succeeded"]);
      assert.equal(marker("exec"), 1);
    });

    await t.test("timeout stops the command and its process group", async () => {
      const started = Date.now();
      const job = await submit("timeout");
      await untilState(job, ["succeeded", "failed"]);
      assert.ok(Date.now() - started < 25_000, "the 1 s time limit, not the 30 s sleep, ended the call");
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(marker("late"), 0);
    });

    await t.test("cancel", async () => {
      const job = await submit("cancel");
      const pidFile = join(workspace, "cancel.pid");
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", 30_000);
      const pid = Number(readFileSync(pidFile, "utf8"));
      assert.equal((await api("POST", `/api/jobs/${job}/cancel`)).status, 200);
      await untilState(job, ["cancelled"]);
      assert.throws(() => process.kill(pid, 0), "the cancelled command's process is gone");
    });

    await t.test("worker restart (SIGTERM, as systemd/launchd stop it) recovers", async () => {
      await stop(worker);
      assert.equal(worker!.child.exitCode, 0, worker!.log());
      readyState = false;
      startWorker();
      await ready();
      const job = await submit("after worker restart");
      await untilState(job, ["succeeded"]);
      assert.equal(marker("after-worker-restart"), 1);
    });

    await t.test("main restart with queued work recovers and runs it once", async () => {
      await stop(worker);
      readyState = false;
      const job = await submit("across main restart");
      assert.equal(await jobState(job), "waiting_worker");
      await stop(main);
      assert.equal(main!.child.exitCode, 0, `exit ${main!.child.exitCode} signal ${main!.child.signalCode}: ${main!.log().split("\n").filter((l) => !l.includes("\"level\":30")).join("\n").slice(-3000)}`);
      assert.ok(!existsSync(join(dataDir, "main.lock")), "SIGTERM released the data directory lock");
      await startMain();
      startWorker();
      await ready();
      await untilState(job, ["succeeded"]);
      assert.equal(marker("across-main-restart"), 1);
    });

    await t.test("online backup from the release's admin command", async () => {
      const out = execFileSync(process.execPath, ["dist/admin.js", "backup", join(dir, "backup.sqlite")], { cwd: join(releaseDir, "apps/server"), env: { PATH: process.env.PATH ?? "", DATA_DIR: dataDir } }).toString();
      const summary = JSON.parse(out);
      assert.equal(summary.integrity, "ok");
      assert.equal(summary.unsettled_calls, 0);
    });

    await t.test("WSS and SSE stay open through Caddy", { skip: caddyBin ? false : "CADDY_BIN not set: the test TLS proxy stood in for Caddy" }, async () => {
      const get = (path: string, extra: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(`${site}${path}`, { ca: readFileSync(ca), headers: extra }, (res) => {
          let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode!, body }));
        });
        req.on("error", reject); req.end();
      });
      assert.match((await get("/health")).body, /"scheduling_ready":true/);
      assert.match((await get("/")).body, /<div id="root">/, "Caddy serves the UI from the release");
      assert.match((await get("/some/deep/link")).body, /<div id="root">/, "and falls back to it for client routes");
      const before = (await workerRow()).connection_epoch;
      // An SSE stream through Caddy, counting every chunk (heartbeat comments included).
      let chunks = 0, ended = false;
      const cursor = (await api("GET", "/api/snapshot")).json.cursor;
      const sse = request(`${site}/api/events?after=${cursor}`, { ca: readFileSync(ca), headers: { cookie: headers.cookie, accept: "text/event-stream" } }, (res) => {
        assert.equal(res.statusCode, 200);
        res.on("data", () => chunks++);
        res.on("end", () => { ended = true; });
      });
      sse.on("error", () => { ended = true; });
      sse.end();
      await new Promise((r) => setTimeout(r, longSecs * 1000));
      // Work still flows over the same worker connection and reaches the stream.
      const seen = chunks;
      const job = await submit("through caddy");
      await untilState(job, ["succeeded"]);
      await waitFor(() => chunks > seen, 10_000);
      assert.equal(ended, false, "the event stream was not cut");
      assert.ok(seen >= Math.floor(longSecs / 15) - 1, `heartbeats arrived through Caddy (${seen} chunks in ${longSecs} s)`);
      assert.equal((await workerRow()).connection_epoch, before, `the worker connection lasted ${longSecs} s without a reconnect`);
      sse.destroy();
    });
  } finally {
    await stop(worker);
    await stop(main);
    await stop(caddy);
    await proxy?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
