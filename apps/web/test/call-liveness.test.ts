import { test } from "node:test";
import assert from "node:assert/strict";
import { QUIET_AFTER_MS, callLiveness, duration, jobActivity } from "../src/call-liveness.ts";

const T0 = 1_000_000;
const on = { online: 1 }, off = { online: 0 };
const running = { state: "running" };
const live = (over: Partial<Parameters<typeof callLiveness>[0]> = {}) =>
  callLiveness({ call: { status: "dispatched", dispatched_at: T0 }, log: undefined, worker: on, job: running, now: T0 + 5_000, ...over });

test("durations read as seconds, minutes, hours", () => {
  assert.equal(duration(45_000), "45秒");
  assert.equal(duration(133_000), "2分13秒");
  assert.equal(duration(3_900_000), "1小时05分");
  assert.equal(duration(-5), "0秒");
});

test("a call not yet sent is only waiting, and can be cancelled with its job", () => {
  const l = live({ call: { status: "committed" } });
  assert.equal(l.phase, "sending");
  assert.equal(l.label, "等待发送");
  assert.equal(l.canCancel, true);
});

test("a running command shows how long it has run and how long since output", () => {
  const fresh = live();
  assert.equal(fresh.phase, "running");
  assert.equal(fresh.detail, "已运行 5秒，暂无输出");
  const output = live({ log: { last_output_at: T0 + 2_000 }, now: T0 + 10_000 });
  assert.equal(output.detail, "已运行 10秒，8秒前有输出");
  assert.equal(output.pulsing, true);
});

test("quiet starts exactly at the threshold, measured from the last output", () => {
  assert.equal(live({ now: T0 + QUIET_AFTER_MS - 1 }).phase, "running");
  const quiet = live({ now: T0 + QUIET_AFTER_MS });
  assert.equal(quiet.phase, "quiet");
  assert.equal(quiet.tone, "warning");
  assert.match(quiet.detail!, /至今没有输出.*可能仍在计算，也可能卡住/);
  // Output resets the clock.
  const lastOutput = T0 + 50_000;
  assert.equal(live({ log: { last_output_at: lastOutput }, now: lastOutput + QUIET_AFTER_MS - 1 }).phase, "running");
  assert.match(live({ log: { last_output_at: lastOutput }, now: lastOutput + QUIET_AFTER_MS }).detail!, /已 1分00秒没有新输出/);
});

test("an offline machine is said to be offline, not running, and the command can still be cancelled", () => {
  const l = live({ worker: off, now: T0 + 5 * 60_000 });
  assert.equal(l.phase, "worker_offline");
  assert.equal(l.pulsing, false);
  assert.equal(l.canCancel, true);
  assert.doesNotMatch(l.detail!, /已运行/);
});

test("a machine nobody has reported on is not called offline", () => {
  assert.equal(live({ worker: undefined }).phase, "running");
});

test("coming back online returns to the elapsed clock", () => {
  assert.equal(live({ worker: off }).phase, "worker_offline");
  assert.equal(live({ worker: on }).phase, "running");
});

test("a stop in progress says whether the signal went out or cannot be delivered", () => {
  const cancelling = { state: "cancel_requested" };
  const notSent = live({ job: cancelling });
  assert.equal(notSent.phase, "cancelling");
  assert.equal(notSent.canCancel, false);
  assert.match(notSent.detail!, /正在发送终止信号/);
  const sent = live({ job: cancelling, call: { status: "dispatched", dispatched_at: T0, cancel_sent_at: T0 + 1_000 }, now: T0 + 4_000 });
  assert.match(sent.detail!, /已发送终止信号 3秒/);
  const away = live({ job: cancelling, worker: off, call: { status: "dispatched", dispatched_at: T0, cancel_sent_at: T0 + 1_000 } });
  assert.match(away.detail!, /机器已离线，重连后才能终止/);
  assert.equal(away.pulsing, false);
});

test("an unknown outcome is never presented as running", () => {
  const l = live({ call: { status: "unknown", dispatched_at: T0 }, job: { state: "needs_attention" } });
  assert.equal(l.phase, "unknown");
  assert.equal(l.tone, "danger");
  assert.equal(l.canCancel, false);
});

test("a finished job's pending call cannot be cancelled again", () => {
  assert.equal(live({ job: { state: "cancelled" } }).canCancel, false);
});

test("the job line follows the job and the machine", () => {
  assert.match(jobActivity({ state: "running", worker_id: "w1" }, on).text, /任务正在执行/);
  assert.match(jobActivity({ state: "running", worker_id: "w1" }, off).text, /机器已离线/);
  assert.match(jobActivity({ state: "running", worker_id: null }, undefined).text, /任务正在执行/);
  assert.match(jobActivity({ state: "waiting_children" }, undefined).text, /委派的子任务/);
  assert.match(jobActivity({ state: "cancel_requested", worker_id: "w1" }, off).text, /重连后才能终止/);
  assert.match(jobActivity({ state: "cancel_requested", worker_id: "w1" }, on).text, /正在停止/);
});
