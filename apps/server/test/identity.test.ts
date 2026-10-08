import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import argon2 from "argon2";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
test("real SQLite migration, reopen, authentication and CSRF boundaries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-"));
  const path = join(dir, "main.sqlite");
  let db = openDatabase(path);
  assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(db.pragma("synchronous", { simple: true }), 2);
  db.prepare("INSERT INTO administrators VALUES (1,?)").run(
    await argon2.hash("controlled-test-password", { type: argon2.argon2id }),
  );
  db.close();
  db = openDatabase(path);
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM schema_migrations").get() as {
        n: number;
      }
    ).n,
    5,
  );
  const app = await createApp(db, "https://localhost:8443", { logging: false });
  try {
    for (const [method, url] of [
      ["GET", "/api/workers"],
      ["POST", "/api/jobs"],
      ["POST", "/api/jobs/job/cancel"],
      ["GET", "/api/history"],
      ["GET", "/api/logs"],
      ["GET", "/api/events"],
      ["GET", "/api/workers/a/workspaces"],
    ] as const)
      assert.equal((await app.inject({ method, url })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { password: "controlled-test-password" },
        })
      ).statusCode,
      403,
    );
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: "https://localhost:8443" },
      payload: { password: "controlled-test-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookie = login.headers["set-cookie"]!.toString().split(";")[0];
    const csrf = login.json().csrf;
    const sessionToken = cookie.slice("session=".length);
    assert.match(login.headers["set-cookie"]!.toString(), /Secure/);
    assert.match(login.headers["set-cookie"]!.toString(), /HttpOnly/);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/worker-tokens",
          headers: { cookie },
          payload: { worker_id: "a" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/worker-tokens",
          headers: {
            cookie,
            origin: "https://attacker.example",
            "x-csrf-token": csrf,
          },
          payload: { worker_id: "a" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/worker-tokens",
          headers: {
            cookie,
            origin: "https://localhost:8443",
            "x-csrf-token": "incorrect",
          },
          payload: { worker_id: "a" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/ws/worker",
          headers: { authorization: "Bearer " + sessionToken },
        })
      ).statusCode,
      401,
    );
    db.prepare(
      "INSERT INTO workers VALUES ('a','boot-a','ledger-a',1,1,1,0,?)",
    ).run(Date.now());
    db.prepare("INSERT INTO worker_slots(worker_id) VALUES ('a')").run();
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run(
      "a",
      "repo-a",
      1,
      "/tmp/a",
      "github.com/example/a",
      1,
    );
    const singleWorkspace = await app.inject({
      url: "/api/workers/a/workspaces",
      headers: { cookie },
    });
    assert.equal(singleWorkspace.statusCode, 200);
    assert.equal(singleWorkspace.json().workspace.workspace_id, "repo-a");
    db.prepare("INSERT INTO workspaces VALUES (?,?,?,?,?,?)").run(
      "a",
      "repo-b",
      2,
      "/tmp/b",
      "github.com/example/b",
      0,
    );
    const noSelection = await app.inject({
      url: "/api/workers/a/workspaces",
      headers: { cookie },
    });
    assert.equal(noSelection.statusCode, 409);
    assert.equal(noSelection.json().error, "workspace_selection_required");
    const selected = await app.inject({
      url: "/api/workers/a/workspaces?workspace_id=repo-b",
      headers: { cookie },
    });
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().workspace.path, "/tmp/b");
    assert.equal(
      (
        await app.inject({
          url: "/api/workers/a/workspaces?workspace_id=missing",
          headers: { cookie },
        })
      ).statusCode,
      404,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/worker-tokens",
      headers: {
        cookie,
        origin: "https://localhost:8443",
        "x-csrf-token": csrf,
      },
      payload: { worker_id: "a" },
    });
    assert.equal(response.statusCode, 200);
    const token = response.json().token;
    assert.equal(
      (
        await app.inject({
          url: "/api/workers",
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM worker_tokens").all()).includes(
        token,
      ),
      false,
    );
    await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: {
        cookie,
        origin: "https://localhost:8443",
        "x-csrf-token": csrf,
      },
    });
    assert.equal(
      (await app.inject({ url: "/api/workers", headers: { cookie } }))
        .statusCode,
      401,
    );
    const logLines: string[] = [];
    const loggingApp = await createApp(db, "https://localhost:8443", {
      logStream: { write: (line) => logLines.push(line) },
    });
    loggingApp.log.info(
      {
        req: {
          headers: {
            authorization: "Bearer test-secret-auth",
            cookie: "session=test-secret-cookie",
          },
          body: { password: "test-secret-password" },
        },
      },
      "redaction probe",
    );
    await loggingApp.close();
    const logged = logLines.join("");
    assert.match(logged, /redaction probe/);
    assert.doesNotMatch(
      logged,
      /test-secret-auth|test-secret-cookie|test-secret-password/,
    );
  } finally {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("migration 001 database upgrades without discarding identity or active slot", async () => {
  const { readFileSync, readdirSync, mkdirSync, writeFileSync } = await import(
    "node:fs"
  );
  const dir = mkdtempSync(join(tmpdir(), "worker-plane-upgrade-"));
  const initial = join(dir, "initial");
  mkdirSync(initial);
  const migrations = new URL("../../../migrations/", import.meta.url);
  writeFileSync(
    join(initial, "001_identity.sql"),
    readFileSync(new URL("001_identity.sql", migrations)),
  );
  const { pathToFileURL } = await import("node:url");
  const path = join(dir, "main.sqlite");
  let db = openDatabase(path, pathToFileURL(initial + "/"));
  db.prepare(
    "INSERT INTO workers VALUES ('a','boot','ledger',7,1,1,0,1)",
  ).run();
  db.prepare("INSERT INTO worker_slots VALUES ('a','inflight')").run();
  db.close();
  db = openDatabase(path);
  assert.equal(
    (
      db.prepare("SELECT count(*) n FROM schema_migrations").get() as {
        n: number;
      }
    ).n,
    5,
  );
  assert.deepEqual(
    db.prepare("SELECT connection_epoch,online,reconciled FROM workers").get(),
    { connection_epoch: 7, online: 0, reconciled: 0 },
  );
  assert.equal(
    (
      db.prepare("SELECT active_job_id FROM worker_slots").get() as {
        active_job_id: string;
      }
    ).active_job_id,
    "inflight",
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
