// P5-A acceptance: the Main Agent delegates to a worker in an isolated child
// session, through the same FIFO as user work. In-process main node, a real
// Rust worker and a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";

const bash = (id: string, command: string, extra: Partial<ScriptStep> = {}): ScriptStep[] => [{ tool: "bash", arguments: { command }, id, ...extra } as ScriptStep, { text: "done" }];
const delegate = (id: string, args: Record<string, unknown>): ScriptStep => ({ tool: "delegate", arguments: { worker_id: "w", ...args }, id });
const result = (s: Awaited<ReturnType<typeof startScenario>>, callId: string) => JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id=?", callId).result_json);

async function mainSession(s: Awaited<ReturnType<typeof startScenario>>) {
  const response = await s.api("GET", "/api/main");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().kind, "main");
  assert.equal((await s.api("GET", "/api/main")).json().session_id, response.json().session_id, "one main session");
  return response.json().session_id as string;
}

test("P5-A delegate: one atomic child per delegation ID, parent injected, isolated child session", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: {
    plan: [
      delegate("d-1", { prompt: "child-a", delegation_key: "a", parent_job_id: "forged", delegation_id: "forged" }),
      delegate("d-2", { prompt: "child-a", delegation_key: "a" }),
      delegate("d-3", { prompt: "child-other", delegation_key: "a" }),
      delegate("d-4", { worker_id: "nobody", prompt: "child-x" }),
      { text: "delegated" },
    ],
    "child-a": bash("child-a-1", "echo child-a >> marker.log"),
    "follow up": bash("follow-1", "echo follow >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const main = await mainSession(s);
    const user = await s.createSession();
    const parent = await s.submit(main, "plan");
    await s.until(() => s.state(parent) === "succeeded");
    const first = result(s, "d-1"), repeat = result(s, "d-2"), conflict = result(s, "d-3"), missing = result(s, "d-4");
    assert.equal(first.ok, true);
    assert.equal(repeat.ok, true);
    assert.equal(repeat.result.job_id, first.result.job_id, "same ID and content returns the original task");
    assert.equal(repeat.result.duplicate, true);
    assert.deepEqual([conflict.ok, conflict.result.error], [false, "delegation_conflict"]);
    assert.deepEqual([missing.ok, missing.result.error], [false, "worker_or_workspace_not_found"]);
    const children = s.all("SELECT * FROM jobs WHERE parent_job_id=?", parent);
    assert.equal(children.length, 1, "exactly one child for one delegation ID");
    const child = children[0];
    assert.equal(s.one("SELECT count(*) n FROM jobs WHERE job_id='forged' OR parent_job_id='forged' OR delegation_id='forged'").n, 0, "the model cannot name the parent or the delegation ID");
    assert.deepEqual([child.delegation_id, child.root_job_id, child.worker_id], ["a", parent, "w"]);
    const session = s.one("SELECT * FROM sessions WHERE session_id=?", child.session_id);
    assert.deepEqual([session.kind, session.worker_id, session.workspace_id, session.parent_job_id, session.delegation_id], ["worker", "w", "repo", parent, "a"]);
    assert.notEqual(child.session_id, user, "a child never shares the user's session");
    assert.notEqual(child.session_id, main);
    await s.until(() => s.state(child.job_id) === "succeeded");
    assert.equal(s.count("child-a"), 1);
    assert.equal(s.one("SELECT count(*) n FROM messages WHERE session_id=?", user).n, 0, "nothing leaked into the user session");
    // The child session takes follow-ups itself, still bound to the same machine and workspace.
    const follow = await s.submit(child.session_id, "follow up");
    await s.until(() => s.state(follow) === "succeeded");
    const followJob = s.one("SELECT worker_id,session_id,parent_job_id FROM jobs WHERE job_id=?", follow);
    assert.deepEqual([followJob.worker_id, followJob.session_id], ["w", child.session_id]);
    assert.equal(s.count("follow"), 1, "the follow-up ran in the bound workspace");
    const event = s.all("SELECT content_json FROM events").map((e) => JSON.parse(e.content_json)).find((e) => e.type === "job_delegated");
    assert.equal(event.job_id, child.job_id);
  } finally { await s.close(); }
});

test("P5-A shared FIFO: user work and delegated work queue in order on one worker, one at a time", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: {
    u1: bash("u1-1", "echo u1-start >> marker.log; sleep 1; echo u1-end >> marker.log"),
    plan: [delegate("fifo-d", { prompt: "child-b" }), { text: "queued" }],
    "child-b": bash("child-b-1", "echo b-start >> marker.log; sleep 1; echo b-end >> marker.log"),
    u2: bash("u2-1", "echo u2-start >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const main = await mainSession(s);
    const user = await s.createSession();
    const u1 = await s.submit(user, "u1");
    await s.until(() => s.state(u1) === "running");
    const parent = await s.submit(main, "plan");
    await s.until(() => s.one("SELECT count(*) n FROM jobs WHERE parent_job_id=?", parent).n === 1);
    const child = s.one("SELECT job_id FROM jobs WHERE parent_job_id=?", parent).job_id;
    const u2 = await s.submit(user, "u2");
    assert.equal(s.one("SELECT active_job_id FROM worker_slots WHERE worker_id='w'").active_job_id, u1, "the main job holds no worker slot");
    await s.until(() => s.state(u2) === "succeeded");
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(`${s.workspace}/marker.log`, "utf8").trim().split("\n");
    assert.deepEqual(lines, ["u1-start", "u1-end", "b-start", "b-end", "u2-start"]);
    const seq = (id: string) => s.one("SELECT queue_seq FROM jobs WHERE job_id=?", id).queue_seq;
    assert.ok(seq(u1) < seq(child) && seq(child) < seq(u2));
    assert.equal(s.one("SELECT queue_seq FROM jobs WHERE job_id=?", parent).queue_seq, null);
  } finally { await s.close(); }
});

test("P5-A dependencies: same task only, and an unmet dependency holds no queue position", { timeout: 60000 }, async () => {
  let other = "";
  const scripts: Record<string, ScriptStep[]> = {
    "dep-a": bash("dep-a-1", "echo a-start >> marker.log; sleep 2; echo a-end >> marker.log"),
    "dep-b": bash("dep-b-1", "echo b >> marker.log"),
    after: bash("after-1", "echo after >> marker.log"),
    other: bash("other-1", "echo other >> marker.log"),
  };
  Object.defineProperty(scripts, "deps", { enumerable: true, get: () => [
    delegate("dep-1", { prompt: "dep-a", delegation_key: "a" }),
    delegate("dep-2", { prompt: "dep-b", delegation_key: "b", depends_on: ["a"] }),
    delegate("dep-3", { prompt: "dep-b", delegation_key: "c", depends_on: ["missing"] }),
    delegate("dep-4", { prompt: "dep-b", delegation_key: "d", depends_on: [other] }),
    { tool: "get_job", arguments: { job_id: other }, id: "dep-5" },
    { text: "planned" },
  ] });
  const s = await startScenario({ scripts });
  try {
    s.startWorker(); await s.ready();
    const main = await mainSession(s);
    const user = await s.createSession();
    other = await s.submit(user, "other");
    await s.until(() => s.state(other) === "succeeded");
    const parent = await s.submit(main, "deps");
    await s.until(() => s.state(parent) === "succeeded");
    assert.deepEqual([result(s, "dep-3").ok, result(s, "dep-3").result.error], [false, "dependency_not_in_task"]);
    assert.deepEqual([result(s, "dep-4").ok, result(s, "dep-4").result.error], [false, "dependency_not_in_task"], "another task's job is not a valid dependency");
    assert.deepEqual([result(s, "dep-5").ok, result(s, "dep-5").result.error], [false, "job_not_found"], "get_job sees only its own task");
    const a = result(s, "dep-1").result.job_id, b = result(s, "dep-2").result;
    assert.equal(b.waiting_for_dependencies, true);
    assert.deepEqual(s.all("SELECT depends_on_job_id FROM job_dependencies WHERE job_id=?", b.job_id).map((r) => r.depends_on_job_id), [a]);
    await s.until(() => s.state(a) === "running");
    const after = await s.submit(user, "after");
    const bRow = s.one("SELECT state,queue_seq FROM jobs WHERE job_id=?", b.job_id);
    assert.deepEqual([bRow.state, bRow.queue_seq], ["queued", null], "no FIFO position while A has not succeeded");
    await s.until(() => s.state(after) === "succeeded");
    const { readFileSync } = await import("node:fs");
    const lines = readFileSync(`${s.workspace}/marker.log`, "utf8").trim().split("\n");
    assert.deepEqual(lines.slice(0, 4), ["other", "a-start", "a-end", "after"], "the waiting job never blocks the queue");
    assert.equal(s.count("b"), 0);
  } finally { await s.close(); }
});
