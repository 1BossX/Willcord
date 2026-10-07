import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once as eventOnce } from "node:events";
import { WebSocket } from "ws";
const once = (emitter: NodeJS.EventEmitter, event: string) =>
  eventOnce(emitter, event, { signal: AbortSignal.timeout(3000) });
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
const token = "controlled-worker-token";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const register = {
  protocol_version: 1,
  type: "register",
  worker_id: "a",
  boot_id: "boot-a",
  ledger_id: "ledger-a",
  workspaces: [
    {
      workspace_id: "repo",
      config_version: 1,
      path: "/tmp",
      repo_id: "github.com/1BossX/WorkerPlane",
      is_default: true,
    },
  ],
};
test(
  "upgrade identity, epoch replacement, reconcile fence and slot retention",
  { timeout: 10000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?, ?, NULL)").run(
      digest(token),
      "a",
    );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const connect = async (auth: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
        headers: { authorization: auth },
      });
      await once(ws, "open");
      return ws;
    };
    try {
      await assert.rejects(connect("Bearer invalid"));
      const a = await connect(`Bearer ${token}`);
      let message = once(a, "message");
      a.send(JSON.stringify(register));
      const ack = JSON.parse((await message)[0].toString());
      assert.equal(ack.connection_epoch, 1);
      message = once(a, "message");
      a.send(JSON.stringify(register));
      const duplicateRegister = JSON.parse((await message)[0].toString());
      assert.equal(duplicateRegister.type, "register_ack");
      assert.equal(duplicateRegister.connection_epoch, 1);
      assert.equal(
        (
          db.prepare("SELECT connection_epoch FROM workers").get() as {
            connection_epoch: number;
          }
        ).connection_epoch,
        1,
      );
      assert.equal(
        (
          db.prepare("SELECT reconciled FROM workers").get() as {
            reconciled: number;
          }
        ).reconciled,
        0,
      );
      for (let i = 0; i < 2; i++) {
        message = once(a, "message");
        a.send(
          JSON.stringify({
            protocol_version: 1,
            type: "resume",
            worker_id: "a",
            connection_epoch: 1,
          }),
        );
        assert.equal(
          JSON.parse((await message)[0].toString()).ack_type,
          "resume",
        );
      }
      message = once(a, "message");
      a.send(
        JSON.stringify({
          protocol_version: 1,
          type: "reconcile",
          worker_id: "a",
          connection_epoch: 1,
          ledger_id: "ledger-a",
          ready: true,
        }),
      );
      await message;
      message = once(a, "message");
      a.send(
        JSON.stringify({
          protocol_version: 1,
          type: "reconcile",
          worker_id: "a",
          connection_epoch: 1,
          ledger_id: "ledger-a",
          ready: true,
        }),
      );
      assert.equal(
        JSON.parse((await message)[0].toString()).ack_type,
        "reconcile",
      );
      assert.equal(
        (
          db.prepare("SELECT reconciled FROM workers").get() as {
            reconciled: number;
          }
        ).reconciled,
        1,
      );
      db.prepare(
        "UPDATE worker_slots SET active_job_id='unresolved-job'",
      ).run();
      const b = await connect(`Bearer ${token}`);
      message = once(b, "message");
      const closed = once(a, "close");
      b.send(JSON.stringify({ ...register, boot_id: "boot-b" }));
      const replacement = JSON.parse((await message)[0].toString());
      assert.equal(replacement.connection_epoch, 2);
      await closed;
      assert.equal(
        (
          db.prepare("SELECT online,reconciled FROM workers").get() as {
            online: number;
            reconciled: number;
          }
        ).online,
        1,
      );
      const bad = once(b, "close");
      b.send(
        JSON.stringify({
          protocol_version: 1,
          type: "heartbeat",
          worker_id: "a",
          connection_epoch: 1,
        }),
      );
      await bad;
      assert.equal(
        (
          db.prepare("SELECT active_job_id FROM worker_slots").get() as {
            active_job_id: string;
          }
        ).active_job_id,
        "unresolved-job",
      );
      assert.equal(
        (db.prepare("SELECT online FROM workers").get() as { online: number })
          .online,
        0,
      );
      const c = await connect("Bearer " + token);
      message = once(c, "message");
      c.send(JSON.stringify({ ...register, boot_id: "boot-c" }));
      const third = JSON.parse((await message)[0].toString());
      assert.equal(third.connection_epoch, 3);
      const blocked = once(c, "close");
      c.send(
        JSON.stringify({
          protocol_version: 1,
          type: "reconcile",
          worker_id: "a",
          connection_epoch: 3,
          ledger_id: "ledger-a",
          ready: true,
        }),
      );
      assert.equal((await blocked)[0], 1008);
      assert.equal(
        (
          db.prepare("SELECT active_job_id FROM worker_slots").get() as {
            active_job_id: string;
          }
        ).active_job_id,
        "unresolved-job",
      );
      assert.equal(
        (db.prepare("SELECT online FROM workers").get() as { online: number })
          .online,
        0,
      );
      const impostor = await connect(`Bearer ${token}`);
      const rejected = once(impostor, "close");
      impostor.send(JSON.stringify({ ...register, worker_id: "other" }));
      await rejected;
    } finally {
      await app.close();
      db.close();
    }
  },
);
test(
  "heartbeat deadline preserves occupied slot and revokes scheduling readiness",
  { timeout: 5000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      "a",
    );
    let clock = 1000;
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
      now: () => clock,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/worker`, {
      headers: { authorization: `Bearer ${token}` },
    });
    try {
      await once(socket, "open");
      const ack = once(socket, "message");
      socket.send(JSON.stringify(register));
      await ack;
      db.prepare("UPDATE worker_slots SET active_job_id='unresolved'").run();
      const closed = once(socket, "close");
      clock += 30000;
      await closed;
      assert.equal(
        (db.prepare("SELECT online FROM workers").get() as { online: number })
          .online,
        0,
      );
      assert.equal(
        (
          db.prepare("SELECT active_job_id FROM worker_slots").get() as {
            active_job_id: string;
          }
        ).active_job_id,
        "unresolved",
      );
    } finally {
      socket.terminate();
      await app.close();
      db.close();
    }
  },
);

test(
  "a token revoked after WSS upgrade cannot register on the existing socket",
  { timeout: 5000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      "a",
    );
    db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(
      digest("admin-session"),
      "csrf-token",
      Date.now() + 60000,
    );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws/worker", {
      headers: { authorization: "Bearer " + token },
    });
    try {
      await once(socket, "open");
      const revoked = await app.inject({
        method: "POST",
        url: "/api/worker-tokens/revoke",
        headers: {
          cookie: "session=admin-session",
          origin: "https://localhost:8443",
          "x-csrf-token": "csrf-token",
        },
        payload: { token },
      });
      assert.equal(revoked.statusCode, 200);
      const closed = once(socket, "close");
      socket.send(JSON.stringify(register));
      assert.equal((await closed)[0], 1008);
      assert.equal(
        (
          db.prepare("SELECT count(*) count FROM workers").get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      socket.terminate();
      await app.close();
      db.close();
    }
  },
);

test(
  "workspace identity cannot change while a worker slot is occupied",
  { timeout: 5000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      "a",
    );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const connect = async () => {
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws/worker", {
        headers: { authorization: "Bearer " + token },
      });
      await once(socket, "open");
      return socket;
    };
    const first = await connect();
    try {
      let message = once(first, "message");
      first.send(JSON.stringify(register));
      await message;
      message = once(first, "message");
      first.send(
        JSON.stringify({
          protocol_version: 1,
          type: "reconcile",
          worker_id: "a",
          connection_epoch: 1,
          ledger_id: "ledger-a",
          ready: true,
        }),
      );
      await message;
      db.prepare("UPDATE worker_slots SET active_job_id='inflight'").run();
      const replacement = await connect();
      const rejected = once(replacement, "close");
      replacement.send(
        JSON.stringify({
          ...register,
          boot_id: "boot-b",
          workspaces: [
            {
              ...register.workspaces[0],
              config_version: 2,
              path: "/tmp/changed",
            },
          ],
        }),
      );
      assert.equal((await rejected)[0], 1008);
      assert.equal(
        (
          db.prepare("SELECT connection_epoch FROM workers").get() as {
            connection_epoch: number;
          }
        ).connection_epoch,
        1,
      );
      assert.equal(
        (db.prepare("SELECT path FROM workspaces").get() as { path: string })
          .path,
        "/tmp",
      );
      assert.equal(first.readyState, WebSocket.OPEN);
    } finally {
      first.terminate();
      await app.close();
      db.close();
    }
  },
);

test(
  "oversized WebSocket messages are rejected at the transport limit",
  { timeout: 5000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      "a",
    );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws/worker", {
      headers: { authorization: "Bearer " + token },
    });
    try {
      await once(socket, "open");
      const closed = once(socket, "close");
      socket.send(" ".repeat(65537));
      assert.equal((await closed)[0], 1009);
    } finally {
      socket.terminate();
      await app.close();
      db.close();
    }
  },
);

test(
  "registration rejects duplicate workspace IDs and ambiguous defaults",
  { timeout: 5000 },
  async () => {
    const db = openDatabase(":memory:");
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(
      digest(token),
      "a",
    );
    const app = await createApp(db, "https://localhost:8443", {
      logging: false,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const connect = async () => {
      const socket = new WebSocket("ws://127.0.0.1:" + port + "/ws/worker", {
        headers: { authorization: "Bearer " + token },
      });
      await once(socket, "open");
      return socket;
    };
    try {
      const duplicateId = await connect();
      const duplicateIdClosed = once(duplicateId, "close");
      duplicateId.send(
        JSON.stringify({
          ...register,
          workspaces: [
            ...register.workspaces,
            { ...register.workspaces[0], path: "/tmp/other" },
          ],
        }),
      );
      assert.equal((await duplicateIdClosed)[0], 1008);
      const multipleDefaults = await connect();
      const defaultsClosed = once(multipleDefaults, "close");
      multipleDefaults.send(
        JSON.stringify({
          ...register,
          workspaces: [
            ...register.workspaces,
            { ...register.workspaces[0], workspace_id: "second" },
          ],
        }),
      );
      assert.equal((await defaultsClosed)[0], 1008);
      assert.equal(
        (
          db.prepare("SELECT count(*) count FROM workers").get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      await app.close();
      db.close();
    }
  },
);
