// P6-C fault program: the event feed across a main-node SIGKILL, and an
// execution that cannot be proven, handled by an operator, as the UI sees it.
// Real Rust workers and a scripted model; the UI's view is the folded feed.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ScriptStep } from "../src/execution.js";
import { buildFaultWorker } from "./support/worker-harness.js";
import { startScenario } from "./support/main-node.js";
import { processScenario } from "./support/main-process.js";
import { fold, openEvents } from "./support/sse.js";

const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];

let faultWorker: string;
before(() => { faultWorker = buildFaultWorker(); });

test("P6-C main SIGKILL with a stream open: after restart the old cursor replays to the complete state", { timeout: 90000 }, async () => {
  const s = await processScenario({ long: bash("k-1", "echo before >> marker.log; sleep 3; echo after >> marker.log") });
  try {
    await s.start();
    s.startWorker();
    await s.until(() => s.one("SELECT reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
    const login = await fetch(`http://127.0.0.1:${s.main.port}/auth/login`, { method: "POST", headers: { origin: "https://localhost:8443", "content-type": "application/json" }, body: JSON.stringify({ password: s.password }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { cookie, origin: "https://localhost:8443", "x-csrf-token": (await login.json()).csrf, "content-type": "application/json" };
    const get = async (path: string) => (await fetch(`http://127.0.0.1:${s.main.port}${path}`, { headers: { cookie } })).json();
    const session = (await (await fetch(`http://127.0.0.1:${s.main.port}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ worker_id: "w", workspace_id: "repo" }) })).json()).session_id;
    const before = await get(`/api/snapshot?session_id=${session}`);

    const first = openEvents(s.main.port, cookie, { after: before.cursor });
    const job = (await (await fetch(`http://127.0.0.1:${s.main.port}/api/sessions/${session}/messages`, { method: "POST", headers, body: JSON.stringify({ client_request_id: "long", message: "long" }) })).json()).job_id;
    await first.until(() => fold(first.events()).get(`call:${job}/k-1`)?.status === "dispatched");
    // The browser's last event before the node dies.
    const lastSeen = first.messages.at(-1)!.id!;
    s.main.child.kill("SIGKILL");
    await s.main.exited;
    await first.until(() => first.ended, 5000);

    // The operator confirms the old process is gone; the browser reconnects with its Last-Event-ID.
    rmSync(join(s.dataDir, "main.lock"), { recursive: true });
    await s.start();
    const second = openEvents(s.main.port, cookie, { lastEventId: lastSeen });
    const view = () => fold([...first.events().filter((e: any) => e.event_id <= lastSeen), ...second.events()]);
    await second.until(() => view().get(`job:${job}`)?.result_json != null && view().get("worker:w")?.active_job_id === null, 30000);
    await second.close();
    assert.ok(second.messages.every((m) => m.id === undefined || m.id > lastSeen), "only events after Last-Event-ID");

    // Nothing the UI needs is missing: it matches a fresh snapshot of the restarted node.
    const after = await get(`/api/snapshot?session_id=${session}`);
    assert.deepEqual(view().get(`job:${job}`), after.session.jobs[0]);
    assert.equal(after.session.jobs[0].state, "succeeded");
    const messageIds = [...view().keys()].filter((k) => k.startsWith("message:")).map((k) => k.slice(8)).sort();
    assert.deepEqual(messageIds, after.session.messages.map((m: any) => m.message_id).sort());
    assert.equal(view().get(`call:${job}/k-1`).status, "completed");
    assert.deepEqual([s.count("before"), s.count("after")], [1, 1], "the command ran once");
  } finally { await s.close(); }
});

test("P6-C needs attention: the feed shows the check, the queued follow-up and each operator action exactly as SQLite records them", { timeout: 90000 }, async () => {
  const s = await startScenario({ scripts: {
    crash: bash("c-1", "echo crash >> marker.log"),
    next: bash("n-1", "echo next >> marker.log"),
  } });
  try {
    // The worker dies after the command ran but before it recorded the result.
    s.startWorker({ binary: faultWorker, env: { WP_FAULT: "after_effect" } });
    await s.ready();
    const session = await s.createSession();
    const { cursor } = (await s.api("GET", `/api/snapshot?session_id=${session}`)).json();
    const feed = openEvents(s.main.port, s.headers.cookie, { after: cursor });
    const view = () => fold(feed.events());
    const job = await s.submit(session, "crash");
    await s.worker!.exited;
    s.startWorker({ binary: faultWorker });
    await feed.until(() => view().get(`job:${job}`)?.state === "needs_attention" && view().get("worker:w")?.blocked === 1);
    assert.equal(view().get(`call:${job}/c-1`).status, "unknown");
    assert.equal(view().get("worker:w").schedulable, false, "online but not schedulable");

    // A follow-up waits behind the check; it does not touch the stuck job.
    const next = await s.submit(session, "next");
    await feed.until(() => view().get(`job:${next}`)?.state === "waiting_worker");
    assert.equal(view().get(`job:${next}`).queue_position, 1);
    assert.equal(view().get(`job:${job}`).state, "needs_attention");

    // Cancel is only recorded: nothing claims the job stopped.
    assert.equal((await s.api("POST", `/api/jobs/${job}/cancel`)).json().state, "needs_attention");
    await feed.until(() => view().get(`job:${job}`)?.cancel_requested === 1);
    assert.equal(view().get(`job:${job}`).state, "needs_attention");

    // Operator: abandon the job, then unblock with the checked outcome.
    assert.equal((await s.api("POST", `/api/jobs/${job}/abandon`, { note: "marker shows one crash line" })).json().state, "cancelled");
    await feed.until(() => view().get(`job:${job}`)?.state === "cancelled");
    assert.equal(view().get("worker:w").blocked, 1, "abandoning does not unblock");
    const unblock = await s.api("POST", "/api/workers/w/unblock", { evidence: "checked marker.log by hand", resolutions: [{ call_id: "c-1", outcome: "executed" }] });
    assert.equal(unblock.statusCode, 200, unblock.body);
    await feed.until(() => view().get("worker:w")?.blocked === 0 && view().get(`job:${next}`)?.state === "succeeded", 30000);
    await feed.close();

    // Every state the UI shows is the database's.
    for (const id of [job, next]) {
      const db = s.one("SELECT state,end_reason,cancel_requested FROM jobs WHERE job_id=?", id);
      const shown = view().get(`job:${id}`);
      assert.deepEqual([shown.state, shown.end_reason, shown.cancel_requested], [db.state, db.end_reason, db.cancel_requested]);
    }
    assert.equal(view().get(`call:${job}/c-1`).status, s.callStatus("c-1"));
    assert.equal(s.callStatus("c-1"), "resolved");
    const w = s.one("SELECT blocked,unblock_pending FROM workers WHERE worker_id='w'");
    assert.deepEqual([view().get("worker:w").blocked, view().get("worker:w").unblock_pending], [w.blocked, w.unblock_pending]);
    assert.ok(feed.events().some((e: any) => e.kind === "attention"), "operator actions are events");
    assert.deepEqual([s.count("crash"), s.count("next")], [1, 1], "nothing was re-run");
  } finally { await s.close(); }
});
