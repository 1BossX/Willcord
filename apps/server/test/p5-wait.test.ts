// P5-B acceptance: waiting on children, dependency order, recovery, parent
// cancel, the shared root budget and structured results. In-process main
// node, a real Rust worker and a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";

type Scenario = Awaited<ReturnType<typeof startScenario>>;
const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];
const delegate = (id: string, args: Record<string, unknown>) => ({ tool: "delegate" as const, arguments: { worker_id: "w", ...args }, id });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (s: Scenario) => existsSync(`${s.workspace}/marker.log`) ? readFileSync(`${s.workspace}/marker.log`, "utf8").trim().split("\n") : [];
const job = (s: Scenario, id: string) => s.one("SELECT * FROM jobs WHERE job_id=?", id);
const child = (s: Scenario, parent: string, key: string) => s.one("SELECT * FROM jobs WHERE parent_job_id=? AND delegation_id=?", parent, key);
const resultOf = (s: Scenario, id: string) => JSON.parse(job(s, id).result_json);
const mainSession = async (s: Scenario) => (await s.api("GET", "/api/main")).json().session_id as string;

/** Test on A, then write notes on B once the test passed: one turn, then a summary. */
const pipeline = (test: string): ScriptStep[] => [
  { calls: [delegate("p-test", { prompt: test, delegation_key: "test" }), delegate("p-doc", { prompt: "doc", delegation_key: "doc", depends_on: ["test"] })] },
  { text: "pipeline finished" },
];

test("P5-B test then notes: the parent waits without model calls, B runs only after A succeeded", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: {
    plan: pipeline("test-ok"),
    "test-ok": bash("ok-1", "echo test-start >> marker.log; sleep 2; echo test-end >> marker.log"),
    doc: bash("doc-1", "echo doc >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const parent = await s.submit(await mainSession(s), "plan");
    await s.until(() => job(s, parent).state === "waiting_children");
    const turns = s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", parent).n;
    assert.equal(s.one("SELECT active_job_id FROM worker_slots").active_job_id, child(s, parent, "test").job_id, "the parent holds no slot");
    await sleep(1000);
    assert.equal(s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", parent).n, turns, "no model call while waiting");
    assert.equal(child(s, parent, "doc").queue_seq, null);
    await s.until(() => job(s, parent).state === "succeeded");
    assert.deepEqual(lines(s), ["test-start", "test-end", "doc"]);
    const a = resultOf(s, child(s, parent, "test").job_id);
    assert.deepEqual([a.outcome, a.exit_code, a.error, a.truncated, a.summary], ["succeeded", 0, null, false, "ok-1 done"]);
    assert.deepEqual(a.evidence_call_ids, ["ok-1"]);
    const p = resultOf(s, parent);
    assert.equal(p.outcome, "succeeded");
    assert.deepEqual(p.children.map((c: any) => [c.delegation_id, c.state]), [["test", "succeeded"], ["doc", "succeeded"]]);
    assert.equal(s.one("SELECT count(*) n FROM runtime_history WHERE job_id=? AND entry_key LIKE 'child:%'", parent).n, 2, "each child result enters the parent history once");
    assert.equal(s.one("SELECT count(*) n FROM job_waits WHERE parent_job_id=?", parent).n, 2);
  } finally { await s.close(); }
});

test("P5-B a failed or cancelled prerequisite never starts B", { timeout: 90000 }, async () => {
  const s = await startScenario({ scripts: {
    failing: pipeline("test-fail"),
    cancelling: [{ calls: [delegate("c-test", { prompt: "test-long", delegation_key: "test" }), delegate("c-doc", { prompt: "doc", delegation_key: "doc", depends_on: ["test"] })] }, { text: "stopped" }],
    "test-fail": bash("fail-1", "echo test-fail >> marker.log; exit 3"),
    "test-long": bash("long-1", "echo long >> marker.log; sleep 30; echo late >> marker.log"),
    doc: bash("doc-1", "echo doc >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const main = await mainSession(s);
    const failing = await s.submit(main, "failing");
    await s.until(() => job(s, failing).state === "succeeded");
    const a = resultOf(s, child(s, failing, "test").job_id);
    assert.deepEqual([a.outcome, a.exit_code, a.error], ["failed", 3, "last_command_failed"]);
    const b = child(s, failing, "doc");
    assert.deepEqual([b.state, b.end_reason, b.queue_seq], ["failed", "dependency_failed", null]);
    assert.equal(s.count("doc"), 0);

    const cancelling = await s.submit(main, "cancelling");
    await s.until(() => s.count("long") === 1);
    const longJob = child(s, cancelling, "test").job_id;
    assert.equal((await s.api("POST", `/api/jobs/${longJob}/cancel`)).statusCode, 200);
    await s.until(() => job(s, cancelling).state === "succeeded");
    assert.equal(job(s, longJob).state, "cancelled");
    assert.deepEqual([child(s, cancelling, "doc").state, child(s, cancelling, "doc").end_reason], ["failed", "dependency_failed"]);
    assert.equal(s.count("doc"), 0);
    assert.equal(s.count("late"), 0);
  } finally { await s.close(); }
});

test("P5-B parent cancel reaches every unfinished child and ends only after they stopped", { timeout: 90000 }, async () => {
  const s = await startScenario({ scripts: {
    plan: [{ calls: [delegate("x-long", { prompt: "test-long", delegation_key: "long" }), delegate("x-doc", { prompt: "doc", delegation_key: "doc", depends_on: ["long"] })] }, { text: "never" }],
    "test-long": bash("long-1", "echo long >> marker.log; sleep 30; echo late >> marker.log"),
    doc: bash("doc-1", "echo doc >> marker.log"),
    user: bash("user-1", "echo user >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const parent = await s.submit(await mainSession(s), "plan");
    await s.until(() => s.count("long") === 1 && job(s, parent).state === "waiting_children");
    const cancelled = await s.api("POST", `/api/jobs/${parent}/cancel`);
    assert.equal(cancelled.json().state, "cancel_requested", "not cancelled while a child may still run");
    await s.until(() => job(s, parent).state === "cancelled");
    const long = child(s, parent, "long"), doc = child(s, parent, "doc");
    assert.deepEqual([long.state, doc.state], ["cancelled", "cancelled"]);
    assert.equal(JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='long-1'").result_json).result.termination, "cancelled");
    assert.equal(s.count("late"), 0);
    assert.equal(s.count("doc"), 0);
    assert.equal(resultOf(s, parent).outcome, "cancelled");
    // The worker is free again for ordinary work.
    const user = await s.submit(await s.createSession(), "user");
    await s.until(() => s.state(user) === "succeeded");
  } finally { await s.close(); }
});

test("P5-B a main restart while waiting recovers from SQLite and never delegates twice", { timeout: 90000 }, async () => {
  const s = await startScenario({ app: { waitSweepMs: 200 }, scripts: {
    plan: [delegate("r-1", { prompt: "child", delegation_key: "only" }), { text: "recovered" }],
    "plan again": [delegate("r-2", { prompt: "child", delegation_key: "only" }), { text: "recovered" }],
    child: bash("child-1", "echo child >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    await s.stopWorker("SIGTERM");
    await s.until(() => s.one("SELECT online FROM workers").online === 0);
    const parent = await s.submit(await mainSession(s), "plan");
    await s.until(() => job(s, parent).state === "waiting_children");
    assert.equal(child(s, parent, "only").state, "waiting_worker");
    await s.stopMain();
    await s.startMain();
    s.startWorker();
    await s.until(() => job(s, parent).state === "succeeded");
    assert.equal(s.count("child"), 1);
    assert.equal(s.one("SELECT count(*) n FROM jobs WHERE parent_job_id=?", parent).n, 1);
    assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=? AND tool_name='delegate'", parent).n, 1);

    // A lost wake-up: the child ends by a write nobody is told about. Only the periodic scan can resume the parent.
    await s.stopWorker("SIGTERM");
    await s.until(() => s.one("SELECT online FROM workers").online === 0);
    const lost = await s.submit(await mainSession(s), "plan again");
    await s.until(() => job(s, lost).state === "waiting_children");
    s.main.db.prepare("UPDATE jobs SET state='cancelled',end_reason='cancelled_by_user' WHERE parent_job_id=?").run(lost);
    await s.until(() => job(s, lost).state === "succeeded");
    assert.equal(resultOf(s, lost).children[0].state, "cancelled");
  } finally { await s.close(); }
});

test("P5-B parent and children share the root budget; delegating again cannot escape it", { timeout: 90000 }, async () => {
  const s = await startScenario({
    app: { budget: { maxToolCalls: 3 } },
    scripts: {
      plan: [delegate("b-1", { prompt: "c1", delegation_key: "c1" }), delegate("b-2", { prompt: "c2", delegation_key: "c2" }), delegate("b-3", { prompt: "c3", delegation_key: "c3" }), { text: "over" }],
      c1: bash("c1-1", "echo c1 >> marker.log"),
      c2: bash("c2-1", "echo c2 >> marker.log"),
      c3: bash("c3-1", "echo c3 >> marker.log"),
    },
  });
  try {
    s.startWorker(); await s.ready();
    const parent = await s.submit(await mainSession(s), "plan");
    await s.until(() => ["succeeded", "failed", "cancelled"].includes(job(s, parent).state));
    assert.equal(s.count("c1"), 1);
    assert.equal(s.count("c2"), 0, "the second child's command is past the shared limit");
    assert.equal(child(s, parent, "c2").end_reason, "budget_tool_calls");
    assert.equal(job(s, parent).end_reason, "budget_tool_calls");
    assert.equal(child(s, parent, "c3"), undefined, "the third delegation is never created");
    assert.equal(s.one("SELECT tool_calls_used FROM budget_roots WHERE root_job_id=?", parent).tool_calls_used, 5);
    assert.equal(s.one("SELECT count(*) n FROM budget_roots").n, 1, "children never get their own root");
    assert.equal(resultOf(s, parent).error, "budget_tool_calls");
  } finally { await s.close(); }
});
