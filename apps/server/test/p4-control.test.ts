// P4-B acceptance: cancel, budgets and operator resolution with an in-process
// main node, a real Rust worker and a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";

const bash = (id: string, command: string, extra: Partial<ScriptStep> = {}): ScriptStep[] => [{ tool: "bash", arguments: { command }, id, ...extra } as ScriptStep, { text: "done" }];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("P4-B cancel during a command: the next job runs only after the process group is gone", { timeout: 90000 }, async (t) => {
  const s = await startScenario({ scripts: {
    long: bash("long-1", "echo long >> marker.log; sleep 30; echo late >> marker.log"),
    next: bash("next-1", "echo next >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const long = await s.submit(session, "long");
    const next = await s.submit(session, "next");
    await s.until(() => s.count("long") === 1);
    const cancelled = await s.api("POST", `/api/jobs/${long}/cancel`);
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().state, "cancel_requested");
    assert.equal(s.state(next), "queued", "the slot stays with the stopping job");
    await s.until(() => s.state(long) === "cancelled");
    const call = JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='long-1'").result_json);
    assert.equal(call.result.termination, "cancelled", "the worker's real result is kept");
    await s.until(() => s.state(next) === "succeeded");
    assert.equal(s.count("late"), 0);
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", long).end_reason, "cancelled_by_user");
    assert.equal((await s.api("POST", `/api/jobs/${long}/cancel`)).json().state, "cancelled", "a terminal job keeps its state");
    t.diagnostic(`long=${long} next=${next}`);
  } finally { await s.close(); }
});

test("P4-B cancel during inference: the late response creates no call", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { slow: bash("slow-1", "echo slow >> marker.log", { delay_ms: 1500 }) } });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "slow");
    await s.until(() => s.state(job) === "running");
    await sleep(300);
    await s.api("POST", `/api/jobs/${job}/cancel`);
    await s.until(() => s.state(job) === "cancelled");
    await sleep(2000);
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=?", job).n, 0);
    assert.equal(s.count("slow"), 0);
  } finally { await s.close(); }
});

test("P4-B queued cancel and an offline cancel: the stop reaches the worker before anything else", { timeout: 90000 }, async () => {
  let dropCalls = true;
  const s = await startScenario({
    scripts: { lost: bash("lost-1", "echo lost >> marker.log"), queued: bash("queued-1", "echo queued >> marker.log") },
    // The worker never sees the first tool_call, so the call stays dispatched.
    drop: (direction, frame) => dropCalls && direction === "to_worker" && frame.type === "tool_call",
  });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const lost = await s.submit(session, "lost");
    const queued = await s.submit(session, "queued");
    await s.until(() => s.callStatus("lost-1") === "dispatched");
    assert.equal((await s.api("POST", `/api/jobs/${queued}/cancel`)).json().state, "cancelled");
    await s.stopWorker("SIGTERM");
    await s.until(() => s.one("SELECT online FROM workers").online === 0);
    assert.equal((await s.api("POST", `/api/jobs/${lost}/cancel`)).json().state, "cancel_requested");
    dropCalls = false;
    const mark = s.proxy.frames.length;
    s.startWorker();
    await s.until(() => s.state(lost) === "cancelled");
    const toWorker = s.proxy.frames.slice(mark).filter((f) => f.direction === "to_worker" && ["cancel_call", "tool_call"].includes(f.type));
    assert.deepEqual(toWorker.map((f) => f.type), ["cancel_call"], "cancel first, the call itself never");
    assert.equal(s.callStatus("lost-1"), "not_executed");
    assert.equal(s.count("lost"), 0);
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=?", queued).n, 0);
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
  } finally { await s.close(); }
});

test("P4-B budgets: tool calls, tokens and deadline each stop the job, and counts survive a restart", { timeout: 120000 }, async () => {
  const two: ScriptStep[] = [{ tool: "bash", arguments: { command: "echo one >> marker.log" }, id: "two-1" }, { tool: "bash", arguments: { command: "echo two >> marker.log" }, id: "two-2" }, { text: "done" }];
  const s = await startScenario({
    scripts: { two, tokens: two.map((step) => "id" in step ? { ...step, id: `tok-${step.id}` } : step), slow: bash("slow-1", "sleep 30") },
    app: { budget: { maxToolCalls: 1, maxTokens: 1_000_000, maxRuntimeSecs: 3600 } },
  });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "two");
    await s.until(() => s.state(job) === "failed");
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", job).end_reason, "budget_tool_calls");
    assert.equal(s.count("one"), 1);
    assert.equal(s.count("two"), 0, "the call over budget is never sent");
    assert.equal(s.callStatus("two-2"), "not_executed");
    const before = s.one("SELECT tool_calls_used,tokens_used FROM budget_roots WHERE root_job_id=?", job);
    assert.equal(before.tool_calls_used, 2);
    assert.ok(before.tokens_used > 0, "usage is counted from the model's reports");
    await s.stopMain(); await s.startMain();
    assert.deepEqual(s.one("SELECT tool_calls_used,tokens_used FROM budget_roots WHERE root_job_id=?", job), before, "a restart never resets counts");
    await s.stopMain(); await s.startMain({ budget: { maxToolCalls: 10, maxTokens: 1, maxRuntimeSecs: 3600 } });
    await s.ready();
    const tokens = await s.submit(session, "tokens");
    await s.until(() => s.state(tokens) === "failed");
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", tokens).end_reason, "budget_tokens");
    assert.equal(s.callStatus("tok-two-2"), undefined, "no generation after the token limit");
    await s.stopMain(); await s.startMain({ budget: { maxToolCalls: 10, maxTokens: 1_000_000, maxRuntimeSecs: 2 } });
    await s.ready();
    const slow = await s.submit(session, "slow");
    const started = Date.now();
    await s.until(() => s.state(slow) === "failed");
    assert.ok(Date.now() - started < 15000);
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", slow).end_reason, "deadline_exceeded");
    assert.equal(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='slow-1'").result_json).result.termination, "cancelled");
  } finally { await s.close(); }
});

test("P4-B worker disk full: nothing runs, the job fails, the worker is not blocked", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { full: bash("full-1", "echo full >> marker.log") } });
  try {
    s.startWorker({ extraConfig: "min_free_bytes = 9223372036854775807\n" }); await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "full");
    await s.until(() => s.state(job) === "failed");
    assert.equal(s.one("SELECT end_reason FROM jobs WHERE job_id=?", job).end_reason, "worker_disk_full");
    assert.equal(s.callStatus("full-1"), "not_executed");
    assert.equal(s.count("full"), 0);
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, null);
  } finally { await s.close(); }
});

test("P4-B abandon, then unblock with evidence, then retry under a new job ID", { timeout: 120000 }, async () => {
  const s = await startScenario({ scripts: {
    // No fixed call ID: the retry must not reuse one the worker has retired.
    crash: [{ tool: "bash", arguments: { command: "echo crash >> marker.log; sleep 30" } }, { text: "done" }],
    after: bash("after-1", "echo after >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "crash");
    await s.until(() => s.count("crash") === 1);
    await s.stopWorker("SIGKILL");
    s.startWorker();
    await s.until(() => s.state(job) === "needs_attention");
    const view = (await s.api("GET", "/api/attention")).json();
    const crashed = s.one("SELECT call_id FROM runtime_calls WHERE job_id=?", job).call_id as string;
    assert.deepEqual(view.calls.map((c: any) => [c.call_id, c.status]), [[crashed, "unknown"]]);
    assert.deepEqual(view.workers.map((w: any) => w.worker_id), ["w"]);

    const early = await s.api("POST", "/api/workers/w/unblock", { evidence: "checked", resolutions: [{ call_id: crashed, outcome: "terminated" }] });
    assert.equal(early.statusCode, 409, "a job still needing attention must be abandoned first");
    assert.equal((await s.api("POST", `/api/jobs/${job}/abandon`, { note: "host rebooted" })).json().state, "cancelled");
    assert.equal(s.one("SELECT blocked FROM workers").blocked, 1, "abandon never unblocks");
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, job);
    const after = await s.submit(session, "after");
    await sleep(1000);
    assert.equal(s.callStatus("after-1"), undefined, "a blocked worker still gets nothing");

    assert.equal((await s.api("POST", "/api/workers/w/unblock", { evidence: "", resolutions: [] })).statusCode, 400);
    const unblock = await s.api("POST", "/api/workers/w/unblock", { evidence: "worker was SIGKILLed; sleep gone; marker shows one line", resolutions: [{ call_id: crashed, outcome: "terminated" }] });
    assert.equal(unblock.statusCode, 200, unblock.body);
    await s.until(() => s.one("SELECT blocked FROM workers").blocked === 0);
    assert.equal(s.callStatus(crashed), "resolved");
    await s.until(() => s.state(after) === "succeeded");
    assert.match(s.one("SELECT evidence FROM attention_actions WHERE action='unblock'").evidence, /marker shows one line/);

    const retry = await s.api("POST", `/api/jobs/${job}/retry`);
    assert.equal(retry.statusCode, 202, retry.body);
    assert.notEqual(retry.json().job_id, job);
    assert.match(retry.json().notice, /副作用/);
    assert.equal((await s.api("POST", `/api/jobs/${retry.json().job_id}/retry`)).statusCode, 409, "only a finished job is retried");
    assert.equal((await s.api("POST", `/api/jobs/${retry.json().job_id}/abandon`, { note: "x" })).statusCode, 409);
    // The retry runs anew; the original side effect is not undone or repeated by recovery.
    await s.until(() => s.count("crash") === 2);
  } finally { await s.close(); }
});
