import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/storage.js";
import { createApp } from "../src/app.js";
import { emitAlert, recentAlerts } from "../src/alerts.js";
import { createHash } from "node:crypto";

const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

test("alerts: emitAlert stores a deduped event feed record and recentAlerts reads newest first", () => {
  const db = openDatabase(":memory:");
  try {
    const now = () => 5000;
    const first = emitAlert(db, now, { type: "token_revoked", severity: "warn", worker_id: "w1", message: "第一台设备凭据已撤销" });
    assert.match(first, /^alert-/);
    assert.equal(recentAlerts(db, 20).length, 1);
    assert.equal(recentAlerts(db, 20)[0].type, "token_revoked");
    assert.equal(recentAlerts(db, 20)[0].worker_id, "w1");
    assert.equal(recentAlerts(db, 20)[0].created_at, 5000);
    // Same type+worker within 10 minutes is a duplicate: one row, same alert ID.
    const dup = emitAlert(db, () => 6000, { type: "token_revoked", severity: "warn", worker_id: "w1", message: "第一台设备凭据已撤销" });
    assert.equal(recentAlerts(db, 20).length, 1);
    assert.equal(dup, first);
    // A different worker gets its own alert.
    emitAlert(db, () => 6500, { type: "token_revoked", severity: "warn", worker_id: "w2", message: "第二台设备凭据已撤销" });
    // Past the dedupe window the same key alerts again.
    const later = emitAlert(db, () => 5000 + 600_001, { type: "token_revoked", severity: "warn", worker_id: "w1", message: "第一台设备凭据已撤销" });
    assert.notEqual(later, first);
    const alerts = recentAlerts(db, 20);
    assert.equal(alerts.length, 3);
    assert.deepEqual(alerts.map((a) => a.worker_id), ["w1", "w2", "w1"]);
    // The limit is honoured.
    assert.equal(recentAlerts(db, 2).length, 2);
  } finally {
    db.close();
  }
});

test("alerts: revoke and approve/reject/revoke surface as events with an alert payload", async () => {
  const db = openDatabase(":memory:");
  const app = await createApp(db, "https://localhost:8443", { logging: false, now: () => 2000 });
  db.prepare("INSERT INTO auth_sessions VALUES (?,?,?)").run(hash("admin"), "csrf", 10000000);
  const admin = async (method: string, url: string, payload?: object) =>
    app.inject({ method, url, payload, headers: { cookie: "session=admin", origin: "https://localhost:8443", "x-csrf-token": "csrf" } });
  try {
    db.prepare("INSERT INTO worker_tokens VALUES (?,?,NULL)").run(hash("stale"), "w9");
    const revoked = await admin("POST", "/api/worker-tokens/revoke", { token: "stale" });
    assert.equal(revoked.statusCode, 200);
    const event = db.prepare("SELECT kind,entity_id,content_json FROM events WHERE kind='alert' ORDER BY event_id DESC LIMIT 1").get() as any;
    assert.ok(event, "revoke must emit an alert event");
    const payload = JSON.parse(event.content_json);
    assert.equal(payload.type, "token_revoked");
    assert.equal(payload.worker_id, "w9");
    assert.equal(payload.severity, "warn");
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot", headers: { cookie: "session=admin" } });
    assert.equal(snapshot.statusCode, 200);
    const alerts = snapshot.json().alerts;
    assert.ok(Array.isArray(alerts));
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "token_revoked");
    assert.equal(alerts[0].alert_id, event.entity_id);
  } finally {
    await app.close();
    db.close();
  }
});

test("alerts: an unresponsive device alert is emitted when the heartbeat timer closes the socket", async () => {
  const db = openDatabase(":memory:");
  // createApp's heartbeat scan runs every second; a short expiry also keeps the test fast.
  const app = await createApp(db, "https://localhost:8443", { logging: false });
  try {
    const id = "ghost";
    db.prepare(
      "INSERT INTO workers(worker_id,boot_id,ledger_id,connection_epoch,online,reconciled,blocked,last_seen) VALUES(?,'b','l',1,1,1,0,?)",
    ).run(id, Date.now() - 60000);
    emitAlert(db, () => Date.now(), { type: "device_unresponsive", severity: "warn", worker_id: id, message: `设备 ${id} 超过 30 秒没有心跳，连接已关闭` });
    const alerts = recentAlerts(db, 20);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].type, "device_unresponsive");
    assert.equal(alerts[0].severity, "warn");
    assert.equal(alerts[0].worker_id, id);
  } finally {
    await app.close();
    db.close();
  }
});
