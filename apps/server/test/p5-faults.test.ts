// P5-C acceptance: delegation across two real Rust workers, a prerequisite
// whose execution is unknown, and main-node crashes at the delegation commit
// points. Side effects are counted as lines in each workspace marker file.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ScriptStep } from "../src/execution.js";
import { buildFaultWorker } from "./support/worker-harness.js";
import { startScenario } from "./support/main-node.js";
import { adminClient, processScenario } from "./support/main-process.js";

const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];
const delegate = (id: string, args: Record<string, unknown>) => ({ tool: "delegate" as const, arguments: args, id });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Machine A tests, then machine B writes notes; one turn, then a summary. */
const twoMachines = (test: string): ScriptStep[] => [
  { calls: [
    delegate("m-test", { worker_id: "w", prompt: test, delegation_key: "test", verify: "grep -q test-end marker.log" }),
    delegate("m-doc", { worker_id: "v", prompt: "doc", delegation_key: "doc", depends_on: ["test"] }),
  ] },
  { text: "two machines done" },
];

let faultWorker: string;
before(() => { faultWorker = buildFaultWorker(); });

test("P5-C machine A tests, then machine B writes notes; B's own queue keeps moving meanwhile", { timeout: 90000 }, async () => {
  const s = await startScenario({ workers: ["w", "v"], scripts: {
    plan: twoMachines("test-ok"),
    "test-ok": bash("ok-1", "echo test-start >> marker.log; sleep 2; echo test-end >> marker.log"),
    doc: bash("doc-1", "echo doc >> marker.log; ls > listing.txt"),
    "on v": bash("onv-1", "echo user-on-v >> marker.log"),
  } });
  try {
    s.startWorker({ id: "w" }); s.startWorker({ id: "v" });
    await s.ready("w"); await s.ready("v");
    const main = (await s.api("GET", "/api/main")).json().session_id;
    const parent = await s.submit(main, "plan");
    await s.until(() => s.count("test-start", "w") === 1);
    // B is waiting for A, so it holds nothing on v: ordinary work there runs now.
    const vSession = (await s.api("POST", "/api/sessions", { worker_id: "v", workspace_id: "repo" })).json().session_id;
    const onV = await s.submit(vSession, "on v");
    await s.until(() => s.state(onV) === "succeeded");
    assert.equal(s.count("test-end", "w"), 0, "A was still running");
    assert.equal(s.count("doc", "v"), 0);
    await s.until(() => s.state(parent) === "succeeded");
    const a = s.one("SELECT * FROM jobs WHERE parent_job_id=? AND delegation_id='test'", parent);
    const b = s.one("SELECT * FROM jobs WHERE parent_job_id=? AND delegation_id='doc'", parent);
    assert.deepEqual([a.worker_id, a.state, b.worker_id, b.state], ["w", "succeeded", "v", "succeeded"]);
    const verified = s.one("SELECT completed_at FROM runtime_calls WHERE call_id=?", `verify-${a.job_id}`).completed_at;
    assert.ok(b.started_at >= verified, "B started only after A's verification passed");
    assert.equal(s.count("doc", "v"), 1);
    assert.equal(s.count("test-end", "v"), 0);
    assert.ok(!existsSync(`${s.workspaceOf("v")}/group.pid`));
    assert.deepEqual(readdirSync(s.workspaceOf("v")).sort(), ["listing.txt", "marker.log"], "no file moved from A to B");
    const result = JSON.parse(s.one("SELECT result_json FROM jobs WHERE job_id=?", parent).result_json);
    assert.deepEqual(result.children.map((c: any) => c.state), ["succeeded", "succeeded"]);
  } finally { await s.close(); }
});

test("P5-C a prerequisite needing attention never starts B; cancelling the parent does not claim a safe stop", { timeout: 120000 }, async () => {
  const s = await startScenario({ workers: ["w", "v"], scripts: {
    plan: twoMachines("test-crash"),
    "test-crash": bash("crash-1", "echo test-start >> marker.log; echo test-end >> marker.log"),
    doc: bash("doc-1", "echo doc >> marker.log"),
  } });
  try {
    // The worker dies after the command ran but before it recorded the result.
    s.startWorker({ id: "w", binary: faultWorker, env: { WP_FAULT: "after_effect" } }); s.startWorker({ id: "v" });
    await s.ready("w"); await s.ready("v");
    const parent = await s.submit((await s.api("GET", "/api/main")).json().session_id, "plan");
    await s.workerOf("w")!.exited;
    s.startWorker({ id: "w", binary: faultWorker });
    const a = () => s.one("SELECT * FROM jobs WHERE parent_job_id=? AND delegation_id='test'", parent);
    const b = () => s.one("SELECT * FROM jobs WHERE parent_job_id=? AND delegation_id='doc'", parent);
    await s.until(() => a().state === "needs_attention");
    assert.equal(s.callStatus("crash-1"), "unknown");
    await sleep(1000);
    assert.deepEqual([b().state, b().queue_seq], ["queued", null], "B holds no place while A is unproven");
    assert.equal(s.state(parent), "waiting_children");

    const cancelled = await s.api("POST", `/api/jobs/${parent}/cancel`);
    assert.equal(cancelled.json().state, "needs_attention", "the parent cannot claim a safe stop");
    assert.equal(b().state, "cancelled");
    assert.equal(a().state, "needs_attention");
    assert.equal(s.count("doc", "v"), 0);
    const view = (await s.api("GET", "/api/attention")).json();
    assert.ok(view.jobs.some((j: any) => j.job_id === parent), "the parent is listed for review");

    // The operator settles A, then gives up on the parent; nothing ever starts B.
    assert.equal((await s.api("POST", `/api/jobs/${a().job_id}/abandon`, { note: "checked marker by hand" })).json().state, "cancelled");
    await sleep(500);
    assert.equal(s.state(parent), "needs_attention", "a parent needing attention stays there until an operator decides");
    assert.equal((await s.api("POST", `/api/jobs/${parent}/abandon`, { note: "child abandoned" })).json().state, "cancelled");
    assert.equal(s.count("doc", "v"), 0);
    assert.equal(b().state, "cancelled");
  } finally { await s.close(); }
});

// The main node dies right after a delegation committed, or right after a
// finished child's result committed; the restarted node finishes the task
// from SQLite without a second delegation or a second run of the child.
for (const point of ["after_delegate_commit", "after_advance_commit"] as const) {
  test(`P5-C main SIGKILL ${point}: restart recovers the parent without delegating twice`, { timeout: 90000 }, async () => {
    const s = await processScenario({
      plan: [delegate("k-1", { worker_id: "w", prompt: "child", delegation_key: "only" }), { text: "recovered" }],
      child: bash("child-1", "echo child >> marker.log"),
    });
    try {
      await s.start({ WP_MAIN_FAULT: point });
      s.startWorker();
      await s.until(() => s.one("SELECT online,reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
      const post = await adminClient(() => s.main.port, s.password);
      const main = (await (await fetch(`http://127.0.0.1:${s.main.port}/api/main`, { headers: { cookie: (await loginCookie(s)) } })).json()).session_id;
      await post(`/api/sessions/${main}/messages`, { client_request_id: "plan", message: "plan" });
      await s.main.exited;
      assert.match(s.main.stderr(), new RegExp(`fault injection: SIGKILL at ${point}`));
      // The operator confirms the old process is gone, as after any unclean exit.
      rmSync(join(s.dataDir, "main.lock"), { recursive: true });
      await s.start();
      const parent = () => s.one("SELECT * FROM jobs WHERE client_request_id='plan'");
      await s.until(() => parent()?.state === "succeeded", 30000);
      assert.equal(s.one("SELECT count(*) n FROM jobs WHERE parent_job_id=?", parent().job_id).n, 1);
      assert.equal(s.one("SELECT count(*) n FROM runtime_calls WHERE job_id=? AND tool_name='delegate'", parent().job_id).n, 1);
      assert.equal(s.count("child"), 1, "the child ran once");
      assert.equal(JSON.parse(parent().result_json).children[0].state, "succeeded");
    } finally { await s.close(); }
  });
}

async function loginCookie(s: Awaited<ReturnType<typeof processScenario>>) {
  const login = await fetch(`http://127.0.0.1:${s.main.port}/auth/login`, { method: "POST", headers: { origin: "https://localhost:8443", "content-type": "application/json" }, body: JSON.stringify({ password: s.password }) });
  return login.headers.get("set-cookie")!.split(";")[0];
}
