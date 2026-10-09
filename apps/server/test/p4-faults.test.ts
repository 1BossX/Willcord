// P4-C acceptance: controlled faults on the cancel path against a real Rust
// worker. The side-effect count is the number of lines in the workspace marker
// file; a stopped command never writes its "late" line.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ScriptStep } from "../src/execution.js";
import { buildFaultWorker } from "./support/worker-harness.js";
import { startScenario } from "./support/main-node.js";
import { adminClient, processScenario } from "./support/main-process.js";

const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: "done" }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A command that runs until stopped and would mark "late" if it outlived the stop. */
const long = (id: string) => bash(id, "echo long >> marker.log; sleep 30; echo late >> marker.log");
const alive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

let faultWorker: string;
before(() => { faultWorker = buildFaultWorker(); });

// after_cancel_recorded: the ledger holds the cancel but nothing was signalled.
// after_term_sent: TERM went out and the worker died inside the grace period.
for (const point of ["after_cancel_recorded", "after_term_sent"] as const) {
  test(`P4-C worker SIGKILL ${point}: the call is unknown, the old group is never killed by a stale ID, and the operator unblocks`, { timeout: 90000 }, async (t) => {
    const s = await startScenario({ scripts: {
      // The group ignores TERM, so it outlives the worker that signalled it.
      stuck: bash("stuck-1", "echo $$ > group.pid; trap '' TERM; echo long >> marker.log; sleep 30; echo late >> marker.log"),
      next: bash("next-1", "echo next >> marker.log"),
    } });
    let pgid = 0;
    try {
      s.startWorker({ binary: faultWorker, env: { WP_FAULT: point } });
      await s.ready();
      const session = await s.createSession();
      const job = await s.submit(session, "stuck");
      t.diagnostic(`job=${job} call=stuck-1`);
      await s.until(() => s.count("long") === 1);
      pgid = Number(readFileSync(join(s.workspace, "group.pid"), "utf8"));
      assert.equal((await s.api("POST", `/api/jobs/${job}/cancel`)).json().state, "cancel_requested");
      await s.worker!.exited;
      assert.match(s.worker!.stderr(), new RegExp(`fault injection: SIGKILL at ${point}`));
      assert.ok(s.one("SELECT cancel_sent_at FROM runtime_calls WHERE call_id='stuck-1'").cancel_sent_at, "the cancel was sent");
      assert.ok(alive(pgid), "the group outlived its worker");

      s.startWorker({ binary: faultWorker });
      await s.until(() => s.state(job) === "needs_attention");
      await s.until(() => s.one("SELECT blocked FROM workers").blocked === 1);
      assert.equal(s.callStatus("stuck-1"), "unknown", "a cancel_ack was never proof of stopping");
      assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, job, "the slot stays held");
      const next = await s.submit(session, "next");
      await sleep(1500);
      assert.ok(alive(pgid), "the restarted worker did not kill the old group by its stale ID");
      assert.equal(s.state(next), "waiting_worker");
      assert.equal(s.count("next"), 0);

      // The operator stops the group by hand, records why, and frees the worker.
      process.kill(-pgid, "SIGKILL");
      await s.until(() => !alive(pgid));
      assert.equal((await s.api("POST", `/api/jobs/${job}/abandon`, { note: "group ignored TERM" })).json().state, "cancelled");
      assert.equal(s.one("SELECT blocked FROM workers").blocked, 1, "abandon never unblocks");
      const unblock = await s.api("POST", "/api/workers/w/unblock", { evidence: `pgid ${pgid} ignored TERM; killed by hand; marker has no late line`, resolutions: [{ call_id: "stuck-1", outcome: "terminated" }] });
      assert.equal(unblock.statusCode, 200, unblock.body);
      await s.until(() => s.one("SELECT blocked FROM workers").blocked === 0);
      assert.equal(s.callStatus("stuck-1"), "resolved");
      await s.until(() => s.state(next) === "succeeded");
      assert.equal(s.count("long"), 1);
      assert.equal(s.count("late"), 0);
      assert.equal(s.count("next"), 1);
    } finally {
      if (pgid && alive(pgid)) process.kill(-pgid, "SIGKILL");
      await s.close();
    }
  });
}

test("P4-C main SIGKILL after the cancel commits: restart still sends the stop and never resumes inference", { timeout: 90000 }, async (t) => {
  const s = await processScenario({ long: long("long-1"), next: bash("next-1", "echo next >> marker.log") });
  try {
    await s.start({ WP_MAIN_FAULT: "after_cancel_commit" });
    s.startWorker();
    await s.until(() => s.one("SELECT reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
    const post = await adminClient(() => s.main.port, s.password);
    const session = (await (await post("/api/sessions", { worker_id: "w", workspace_id: "repo" })).json()).session_id;
    const job = (await (await post(`/api/sessions/${session}/messages`, { client_request_id: "long", message: "long" })).json()).job_id;
    t.diagnostic(`job=${job} call=long-1`);
    await s.until(() => s.count("long") === 1);
    const turns = s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", job).n;

    const killed = s.main;
    await post(`/api/jobs/${job}/cancel`, {}).catch(() => undefined);
    await killed.exited;
    assert.equal(killed.child.signalCode, "SIGKILL");
    assert.match(killed.stderr(), /fault injection: SIGKILL at after_cancel_commit/);
    const call = s.one("SELECT status,cancel_sent_at FROM runtime_calls WHERE call_id='long-1'");
    assert.deepEqual([call.status, call.cancel_sent_at], ["dispatched", null], "the stop was committed but never sent");
    assert.equal(s.one("SELECT state FROM jobs WHERE job_id=?", job).state, "cancel_requested");

    rmSync(join(s.dataDir, "main.lock"), { recursive: true });
    const mark = s.proxy.frames.length;
    await s.start();
    await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", job).state === "cancelled");
    assert.ok(s.proxy.frames.slice(mark).some((f) => f.type === "cancel_call" && f.call_id === "long-1"), "the restarted node sent the stop");
    assert.equal(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='long-1'").result_json).result.termination, "cancelled");
    assert.equal(s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", job).n, turns, "inference was not resumed");
    assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"assistant\"%'", job).n, 0, "no final answer after cancel");
    assert.equal(s.count("late"), 0);
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);

    const repost = await adminClient(() => s.main.port, s.password);
    const next = (await (await repost(`/api/sessions/${session}/messages`, { client_request_id: "next", message: "next" })).json()).job_id;
    await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", next).state === "succeeded");
    assert.equal(s.count("long"), 1);
  } finally { await s.close(); }
});

// The lost frame goes with its connection; after reconnecting, the main node
// repeats the stop before anything else and the job still ends cancelled.
for (const [direction, type] of [["to_worker", "cancel_call"], ["to_main", "cancel_ack"]] as const) {
  test(`P4-C ${type} lost with its connection: reconnect repeats the stop and the command still ends`, { timeout: 60000 }, async (t) => {
    let lost = false;
    const s = await startScenario({
      scripts: { long: long("long-1"), next: bash("next-1", "echo next >> marker.log") },
      drop: (d, frame) => {
        if (lost || d !== direction || frame.type !== type) return false;
        lost = true;
        setImmediate(() => s.proxy.dropAll());
        return true;
      },
    });
    try {
      s.startWorker(); await s.ready();
      const epoch = s.one("SELECT connection_epoch FROM workers").connection_epoch;
      const session = await s.createSession();
      const job = await s.submit(session, "long");
      t.diagnostic(`job=${job} call=long-1`);
      await s.until(() => s.count("long") === 1);
      await s.api("POST", `/api/jobs/${job}/cancel`);
      await s.until(() => s.state(job) === "cancelled");
      assert.ok(lost, `${type} was dropped`);
      assert.ok(s.one("SELECT connection_epoch FROM workers").connection_epoch > epoch, "finished on a reconnected epoch");
      assert.equal(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='long-1'").result_json).result.termination, "cancelled");
      assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
      assert.equal(s.one("SELECT count(*) n FROM attention_actions").n, 0);
      const next = await s.submit(session, "next");
      await s.until(() => s.state(next) === "succeeded");
      assert.equal(s.count("late"), 0);
      assert.equal(s.count("next"), 1);
    } finally { await s.close(); }
  });
}

test("P4-C duplicate cancel_call and cancel_ack are idempotent", { timeout: 60000 }, async (t) => {
  const s = await startScenario({
    scripts: { long: long("long-1"), next: bash("next-1", "echo next >> marker.log") },
    duplicate: (_d, frame) => frame.type === "cancel_call" || frame.type === "cancel_ack",
  });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "long");
    t.diagnostic(`job=${job} call=long-1`);
    await s.until(() => s.count("long") === 1);
    await s.api("POST", `/api/jobs/${job}/cancel`);
    await s.api("POST", `/api/jobs/${job}/cancel`);
    await s.until(() => s.state(job) === "cancelled");
    const delivered = (type: string) => s.proxy.frames.filter((f) => f.type === type && !f.dropped).length;
    assert.ok(delivered("cancel_call") >= 2 && delivered("cancel_ack") >= 2, "both frames arrived twice");
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", job).end_reason, "cancelled_by_user");
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
    assert.equal(s.one("SELECT count(*) n FROM attention_actions").n, 0);
    const next = await s.submit(session, "next");
    await s.until(() => s.state(next) === "succeeded");
    assert.equal(s.count("late"), 0);
  } finally { await s.close(); }
});
