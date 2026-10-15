// The UI's feed rules, without a browser: each event once, latest state per
// entity, only the open session's records, committed drafts never shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceCursor, applyEvent, fromSnapshot, type FeedEvent, type Snapshot } from "../src/feed-state.ts";

const snapshot: Snapshot = {
  cursor: 10,
  main_session_id: "main",
  workers: [{ worker_id: "w", online: 1, schedulable: true }],
  sessions: [{ session_id: "s1" }, { session_id: "s2" }],
  session: { session: { session_id: "s1" }, messages: [{ message_id: "m1", seq: 1 }], jobs: [{ job_id: "j1", state: "running" }], calls: [], logs: [], drafts: [] },
};
const ev = (event_id: number, kind: string, entity_id: string, data: any, session_id: string | null = "s1", job_id: string | null = "j1"): FeedEvent => ({ event_id, kind, entity_id, session_id, job_id, data });

test("an event at or below the cursor is a repeat and changes nothing", () => {
  const start = fromSnapshot(snapshot, "s1");
  assert.equal(applyEvent(start, ev(10, "job", "j1", { job_id: "j1", state: "failed" })), start);
  const once = applyEvent(start, ev(11, "message", "m2", { message_id: "m2", seq: 2 }));
  const twice = applyEvent(once, ev(11, "message", "m2", { message_id: "m2", seq: 2 }));
  assert.equal(twice, once);
  assert.deepEqual(Object.keys(twice.messages), ["m1", "m2"]);
});

test("dispatch pause events update the banner state; snapshot alerts land newest first", () => {
  let s = fromSnapshot(snapshot, "s1");
  assert.equal(s.dispatch, null);
  s = applyEvent(s, ev(11, "dispatch", "main", { paused: 1, reason: "operator", note: "巡检中", since: 1700000000000 }, null, null));
  assert.equal(s.dispatch?.paused, 1);
  assert.equal(s.dispatch?.reason, "operator");
  s = applyEvent(s, ev(12, "dispatch", "main", { paused: 0, reason: null, note: null, since: null }, null, null));
  assert.equal(s.dispatch?.paused, 0);
  // Alerts prepend, cap at 20 and bump the attention version.
  const base = fromSnapshot({ ...snapshot, alerts: [{ alert_id: "a0", type: "token_revoked", severity: "warn", worker_id: "w", message: "旧告警", created_at: 1 }] }, "s1");
  assert.equal(base.alerts.length, 1);
  let withAlert = applyEvent(base, ev(13, "alert", "alert-x", { alert_id: "alert-x", type: "device_unresponsive", severity: "error", worker_id: "w", message: "设备失联", created_at: 2 }, null, null));
  assert.equal(withAlert.alerts[0].alert_id, "alert-x");
  assert.equal(withAlert.alerts.length, 2);
  assert.equal(withAlert.attentionVersion, base.attentionVersion + 1);
  for (let i = 0; i < 25; i++) withAlert = applyEvent(withAlert, ev(14 + i, "alert", `alert-${i}`, { alert_id: `alert-${i}`, type: "device_unresponsive", severity: "info", worker_id: "w", message: "n", created_at: 3 }, null, null));
  assert.equal(withAlert.alerts.length, 20);
  // An alert with no payload (event retention) leaves the list alone.
  const empty = applyEvent(withAlert, ev(99, "alert", "alert-gone", null, null, null));
  assert.equal(empty.alerts.length, 20);
});

test("the latest state of an entity replaces the earlier one", () => {
  let s = fromSnapshot(snapshot, "s1");
  s = applyEvent(s, ev(11, "job", "j1", { job_id: "j1", state: "cancel_requested" }));
  s = applyEvent(s, ev(12, "job", "j1", { job_id: "j1", state: "cancelled" }));
  assert.equal(s.jobs.j1.state, "cancelled");
  assert.equal(s.cursor, 12);
});

test("records of another session are not shown; machines and sessions are global", () => {
  let s = fromSnapshot(snapshot, "s1");
  s = applyEvent(s, ev(11, "message", "x", { message_id: "x" }, "s2", "j9"));
  s = applyEvent(s, ev(12, "job", "j9", { job_id: "j9" }, "s2", "j9"));
  s = applyEvent(s, ev(13, "worker", "w", { worker_id: "w", online: 0, schedulable: false }, null, null));
  s = applyEvent(s, ev(14, "session", "s3", { session_id: "s3" }, "s3", null));
  assert.deepEqual(Object.keys(s.messages), ["m1"]);
  assert.deepEqual(Object.keys(s.jobs), ["j1"]);
  assert.equal(s.workers.w.schedulable, false);
  assert.ok(s.sessions.s3);
  assert.equal(s.cursor, 14, "skipped records still move the cursor");
});

test("a committed draft disappears, an interrupted one stays", () => {
  let s = fromSnapshot(snapshot, "s1");
  s = applyEvent(s, ev(11, "draft", "d1", { draft_id: "d1", state: "streaming", text: "partial" }));
  s = applyEvent(s, ev(12, "draft", "d2", { draft_id: "d2", state: "interrupted", text: "cut" }));
  s = applyEvent(s, ev(13, "draft", "d1", { draft_id: "d1", state: "committed", text: "" }));
  assert.deepEqual(Object.keys(s.drafts), ["d2"]);
});

test("a deleted entity is removed; cursor markers only move forward", () => {
  let s = fromSnapshot(snapshot, "s1");
  s = applyEvent(s, ev(11, "message", "m1", null));
  assert.deepEqual(s.messages, {});
  s = advanceCursor(s, 20);
  assert.equal(s.cursor, 20);
  assert.equal(advanceCursor(s, 15), s);
  assert.equal(applyEvent(s, ev(19, "job", "j1", { state: "x" })), s, "events the marker covered are not applied again");
});

test("attention-relevant changes bump the attention version", () => {
  const s = fromSnapshot(snapshot, "s1");
  assert.ok(applyEvent(s, ev(11, "attention", "a", {}, null)).attentionVersion > s.attentionVersion);
  assert.ok(applyEvent(s, ev(11, "job", "j1", { job_id: "j1", state: "needs_attention" })).attentionVersion > s.attentionVersion);
  assert.equal(applyEvent(s, ev(11, "job", "j1", { job_id: "j1", state: "succeeded" })).attentionVersion, s.attentionVersion);
});

test("the dispatch pause comes from the snapshot and follows its events", () => {
  const paused = { paused: 1, reason: "restored", note: "from backup", since: 1 };
  let state = fromSnapshot({ ...snapshot, dispatch: paused }, null);
  assert.deepEqual(state.dispatch, paused);
  state = applyEvent(state, { event_id: 11, kind: "dispatch", entity_id: "dispatch", session_id: null, job_id: null, data: { paused: 0, reason: null, note: null, since: null } });
  assert.equal(state.dispatch?.paused, 0);
});
