import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
test(
  "two real Rust workers over verified WSS, directory lock, identity restart and revocation",
  { timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "worker-plane-wss-"));
    const root = resolve("../..");
    const cert = join(dir, "cert.pem"),
      key = join(dir, "key.pem"),
      ca = join(dir, "ca.pem"),
      caKey = join(dir, "ca-key.pem"),
      csr = join(dir, "cert.csr"),
      ext = join(dir, "cert.ext");
    const openssl = (args: string[]) =>
      execFileSync("openssl", args, { stdio: "ignore" });
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      ca,
      "-days",
      "1",
      "-subj",
      "/CN=Worker Plane Test CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      "/CN=localhost",
    ]);
    writeFileSync(
      ext,
      "basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n",
    );
    openssl([
      "x509",
      "-req",
      "-in",
      csr,
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      cert,
      "-days",
      "1",
      "-extfile",
      ext,
    ]);
    const db = openDatabase(join(dir, "main.sqlite"));
    const tokens = {
      a: "controlled-wss-token-a",
      b: "controlled-wss-token-b",
      c: "controlled-wss-token-c",
    };
    for (const [id, token] of Object.entries(tokens))
      db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
        createHash("sha256").update(token).digest("hex"),
        id,
      );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as { port: number };
    // TLS termination equivalent to Caddy, with an internal loopback WS hop.
    const proxy = createServer({
      key: readFileSync(key),
      cert: readFileSync(cert),
    });
    const gateway = new WebSocketServer({ noServer: true, maxPayload: 65536 });
    proxy.on("upgrade", (req, socket, head) => {
      const upstream = new WebSocket(
        `ws://127.0.0.1:${address.port}${req.url}`,
        { headers: { authorization: req.headers.authorization ?? "" } },
      );
      upstream.on("unexpected-response", (_req, res) => {
        socket.end(
          `HTTP/1.1 ${res.statusCode} Unauthorized\r\nConnection: close\r\n\r\n`,
        );
      });
      upstream.on("error", () => socket.destroy());
      upstream.on("open", () =>
        gateway.handleUpgrade(req, socket, head, (client) => {
          let injectedOversizedFrame = false;
          client.on("message", (data) => {
            upstream.send(data.toString());
            if (
              req.headers.authorization === "Bearer controlled-wss-token-c" &&
              !injectedOversizedFrame
            ) {
              injectedOversizedFrame = true;
              client.send(" ".repeat(65537));
            }
          });
          upstream.on("message", (data) => client.send(data.toString()));
          client.on("close", () => upstream.close());
          upstream.on("close", (code, reason) => client.close(code, reason));
          client.on("error", () => upstream.terminate());
        }),
      );
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const port = (proxy.address() as { port: number }).port;
    const children: ReturnType<typeof spawn>[] = [];
    const start = (id: "a" | "b" | "c") => {
      const config = join(dir, `${id}.toml`);
      writeFileSync(
        config,
        `worker_id = "${id}"\ndata_dir = "${dir}/${id}"\nurl = "wss://localhost:${port}/ws/worker"\n[[workspaces]]\nworkspace_id = "repo"\nconfig_version = 1\npath = "${root}"\nrepo_id = "github.com/1BossX/WorkerPlane"\nis_default = true\n`,
      );
      const env = { ...process.env, WORKER_TOKEN: tokens[id], SSL_CERT_FILE: ca };
      // rustls-native-certs prefers SSL_CERT_DIR over SSL_CERT_FILE when both are set.
      delete env.SSL_CERT_DIR;
      const child = spawn(
        join(root, "worker/target/debug/worker-plane-worker"),
        [config],
        {
          env,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (d) => (stderr += d));
      return { child, stderr: () => stderr };
    };
    try {
      const a = start("a"),
        b = start("b");
      await waitFor(() => {
        if (a.child.exitCode !== null || b.child.exitCode !== null)
          throw new Error(a.stderr() + b.stderr());
        return (
          (
            db
              .prepare(
                "SELECT count(*) n FROM workers WHERE online=1 AND reconciled=1",
              )
              .get() as { n: number }
          ).n === 2
        );
      });
      const oversizedFrame = start("c");
      await once(oversizedFrame.child, "exit");
      assert.notEqual(oversizedFrame.child.exitCode, 0);
      assert.match(oversizedFrame.stderr(), /MessageTooLong/);
      const before = db
        .prepare("SELECT * FROM workers WHERE worker_id='a'")
        .get() as {
        boot_id: string;
        ledger_id: string;
        connection_epoch: number;
      };
      const duplicate = start("a");
      await once(duplicate.child, "exit");
      assert.notEqual(duplicate.child.exitCode, 0);
      assert.match(duplicate.stderr(), /already locked/);
      const exit = once(a.child, "exit");
      a.child.kill("SIGINT");
      await exit;
      await waitFor(
        () =>
          (
            db
              .prepare("SELECT online FROM workers WHERE worker_id='a'")
              .get() as { online: number }
          ).online === 0,
      );
      const restarted = start("a");
      await waitFor(() => {
        if (restarted.child.exitCode !== null)
          throw new Error(restarted.stderr());
        return (
          (
            db
              .prepare(
                "SELECT connection_epoch FROM workers WHERE worker_id='a'",
              )
              .get() as { connection_epoch: number }
          ).connection_epoch > before.connection_epoch
        );
      });
      const after = db
        .prepare("SELECT * FROM workers WHERE worker_id='a'")
        .get() as typeof before;
      assert.notEqual(after.boot_id, before.boot_id);
      assert.equal(after.ledger_id, before.ledger_id);
      db.prepare(
        "UPDATE worker_slots SET active_job_id='unresolved' WHERE worker_id='b'",
      ).run();
      db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(
        createHash("sha256").update("admin-test-session").digest("hex"),
        "csrf-test",
        Date.now() + 60000,
      );
      const revoked = await app.inject({
        method: "POST",
        url: "/api/worker-tokens/revoke",
        headers: {
          cookie: "session=admin-test-session",
          origin: "https://localhost:8443",
          "x-csrf-token": "csrf-test",
        },
        payload: { token: tokens.b },
      });
      assert.equal(revoked.statusCode, 200);
      await waitFor(
        () =>
          (
            db
              .prepare("SELECT online FROM workers WHERE worker_id='b'")
              .get() as { online: number }
          ).online === 0,
      );
      assert.equal(
        (
          db
            .prepare(
              "SELECT active_job_id FROM worker_slots WHERE worker_id='b'",
            )
            .get() as { active_job_id: string }
        ).active_job_id,
        "unresolved",
      );
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          const exit = once(child, "exit");
          child.kill("SIGKILL");
          await exit;
        }
      }
      for (const client of gateway.clients) client.terminate();
      await app.close();
      await new Promise<void>((r) => proxy.close(() => r()));
      gateway.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
