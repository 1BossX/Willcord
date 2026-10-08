// P3-C acceptance: controlled faults against a real Rust worker and the main
// node. The side-effect count is the number of lines in the workspace marker
// file, never the number of frames sent.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ScriptStep } from "../src/execution.js";
import { buildFaultWorker } from "./support/worker-harness.js";
import { startScenario } from "./support/main-node.js";

/** One bash call that appends `tag` to marker.log, then a final answer. */
const marking = (callId: string, tag: string, extra = ""): ScriptStep[] => [
  { tool: "bash", arguments: { command: `echo ${tag} >> marker.log${extra}` }, id: callId },
  { text: "done" },
];

let faultWorker: string;
before(() => { faultWorker = buildFaultWorker(); });

for (const point of ["after_accepted", "after_running", "after_effect"] as const) {
  test(`P3-C worker SIGKILL ${point}: execution cannot be proven, so the job needs attention and the worker blocks`, { timeout: 60000 }, async (t) => {
    const s = await startScenario({ scripts: { crash: marking("crash-1", "crash"), next: marking("next-1", "next") } });
    try {
      s.startWorker({ binary: faultWorker, env: { WP_FAULT: point } });
      await s.ready();
      const session = await s.createSession();
      const job = await s.submit(session, "crash");
      t.diagnostic(`job=${job} call=crash-1`);
      const crashed = s.worker!;
      await crashed.exited;
      assert.equal(crashed.child.signalCode, "SIGKILL");
      assert.match(crashed.stderr(), new RegExp(`fault injection: SIGKILL at ${point}`));
      const effects = point === "after_effect" ? 1 : 0;
      assert.equal(s.count("crash"), effects);

      s.startWorker({ binary: faultWorker });
      await s.until(() => s.state(job) === "needs_attention");
      await s.until(() => s.one("SELECT blocked FROM workers").blocked === 1);
      assert.equal(s.callStatus("crash-1"), "unknown");
      assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, job, "the slot stays held");
      assert.match(s.one("SELECT evidence FROM attention_actions WHERE job_id=?", job).evidence, /worker_reports_unknown_execution/);
      const next = await s.submit(session, "next");
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(s.state(next), "waiting_worker");
      assert.equal(s.callStatus("next-1"), undefined, "a blocked worker gets no new call");
      assert.equal(s.count("crash"), effects, "recovery never re-executes");
      assert.equal(s.count("next"), 0);
    } finally { await s.close(); }
  });
}

test("P3-C worker SIGKILL after_result_persisted: the original result is returned and the job succeeds", { timeout: 60000 }, async (t) => {
  const s = await startScenario({ scripts: { done: marking("done-1", "done"), next: marking("next-1", "next") } });
  try {
    s.startWorker({ binary: faultWorker, env: { WP_FAULT: "after_result_persisted" } });
    await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "done");
    t.diagnostic(`job=${job} call=done-1`);
    await s.worker!.exited;
    assert.match(s.worker!.stderr(), /fault injection: SIGKILL at after_result_persisted/);
    assert.equal(s.callStatus("done-1"), "dispatched", "the main node never saw the result");

    s.startWorker({ binary: faultWorker });
    await s.until(() => s.state(job) === "succeeded");
    assert.equal(s.count("done"), 1);
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
    assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"tool\"%'", job).n, 1);
    const next = await s.submit(session, "next");
    await s.until(() => s.state(next) === "succeeded");
    assert.equal(s.count("done"), 1);
    assert.equal(s.count("next"), 1);
  } finally { await s.close(); }
});

// After reconnecting, the lost frame's purpose is served again: a lost
// acceptance is superseded by the cached result, every other frame is repeated.
for (const [direction, type, repeated] of [["to_worker", "tool_call", "tool_call"], ["to_main", "tool_accepted", "tool_result"], ["to_main", "tool_result", "tool_result"], ["to_worker", "tool_ack", "tool_ack"]] as const) {
  test(`P3-C ${type} lost with its connection: reconnect reconciles and the effect happens once`, { timeout: 60000 }, async (t) => {
    let lost = false;
    const s = await startScenario({
      scripts: { lose: marking("lose-1", "lose", "; sleep 1"), next: marking("next-1", "next") },
      drop: (d, frame) => {
        if (lost || d !== direction || frame.type !== type || frame.call_id !== "lose-1") return false;
        lost = true;
        setImmediate(() => s.proxy.dropAll());
        return true;
      },
    });
    try {
      s.startWorker();
      await s.ready();
      const epoch = s.one("SELECT connection_epoch FROM workers").connection_epoch;
      const session = await s.createSession();
      const job = await s.submit(session, "lose");
      t.diagnostic(`job=${job} call=lose-1`);
      const delivered = () => s.proxy.frames.filter((f) => f.call_id === "lose-1" && f.type === repeated && !f.dropped);
      await s.until(() => s.state(job) === "succeeded" && delivered().length > 0);
      assert.ok(lost, `${type} was dropped`);
      assert.ok(s.one("SELECT connection_epoch FROM workers").connection_epoch > epoch, "finished on a reconnected epoch");
      assert.equal(s.count("lose"), 1, "one side effect");
      assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
      assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"tool\"%'", job).n, 1, "one tool message");
      // The worker re-sends unacked results after worker_ready while the main
      // node re-sends the waiting call, so results and ACKs may arrive twice;
      // duplicates are idempotent and never repeat the effect or the message.
      const next = await s.submit(session, "next");
      await s.until(() => s.state(next) === "succeeded");
      assert.equal(s.count("lose"), 1);
    } finally { await s.close(); }
  });
}

test("P3-C a lost worker ledger blocks the worker; missing records never prove a call did not run", { timeout: 60000 }, async (t) => {
  const s = await startScenario({ scripts: { lost: marking("lost-1", "lost", "; sleep 30"), next: marking("next-1", "next") } });
  try {
    s.startWorker();
    await s.ready();
    const ledger = s.one("SELECT ledger_id FROM workers").ledger_id;
    const session = await s.createSession();
    const job = await s.submit(session, "lost");
    t.diagnostic(`job=${job} call=lost-1`);
    await s.until(() => s.count("lost") === 1);
    await s.stopWorker();
    rmSync(join(s.dir, "w-data"), { recursive: true, force: true });

    s.startWorker();
    await s.until(() => s.one("SELECT blocked FROM workers").blocked === 1);
    const next = await s.submit(session, "next");
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(s.one("SELECT ledger_id FROM workers").ledger_id, ledger, "the main node keeps the identity it reconciled against");
    assert.equal(s.one("SELECT reconciled FROM workers").reconciled, 0, "a new ledger never reconciles");
    assert.notEqual(s.callStatus("lost-1"), "completed");
    assert.notEqual(s.state(job), "succeeded");
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, job, "the slot stays held");
    assert.equal(s.state(next), "waiting_worker");
    assert.equal(s.count("lost"), 1, "the call was not re-run on the new ledger");
    assert.equal(s.count("next"), 0);
    assert.equal(s.proxy.frames.filter((f) => f.type === "tool_call" && f.call_id === "lost-1").length, 1, "the call was never re-sent");
  } finally { await s.close(); }
});
