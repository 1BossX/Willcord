// P6-A acceptance: snapshot with a cursor, SSE replay, cursor expiry, auth on
// the feed, model drafts, and an event for every state the UI shows.
// In-process main node, a real Rust worker and a scripted model.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScriptStep } from "../src/execution.js";
import { pruneEvents } from "../src/feed.js";
import { startScenario } from "./support/main-node.js";
import { fold, openEvents } from "./support/sse.js";

type Scenario = Awaited<ReturnType<typeof startScenario>>;
const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];
const stream = (s: Scenario, query: Parameters<typeof openEvents>[2]) => openEvents(s.main.port, s.headers.cookie, query);
const snapshotOf = async (s: Scenario, session?: string) => {
  const response = await s.api("GET", `/api/snapshot${session ? `?session_id=${session}` : ""}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
};
const increasing = (ids: number[]) => ids.every((id, i) => i === 0 || id > ids[i - 1]);

test("P6-A snapshot cursor then SSE: a replay after a disconnect leaves no key state missing", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { run: bash("r-1", "echo run >> marker.log") } });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const before = await snapshotOf(s, session);
    assert.deepEqual(before.session.jobs, []);
    const w = before.workers.find((x: any) => x.worker_id === "w");
    assert.equal(w.online, 1);
    assert.equal(w.schedulable, true);

    const a = stream(s, { after: before.cursor });
    const job = await s.submit(session, "run");
    const settled = () => {
      const state = fold(a.events());
      return state.get(`job:${job}`)?.result_json != null && state.get("worker:w")?.active_job_id === null;
    };
    await a.until(settled);
    const ids = a.messages.map((m) => m.id!).filter((id) => id !== undefined);
    assert.ok(increasing(ids), "event IDs only grow");
    assert.ok(ids.every((id) => id > before.cursor), "nothing at or before the snapshot cursor is replayed");
    const mid = a.messages[Math.floor(a.messages.length / 2)].id!;
    await a.close();

    // Everything the UI needs is in the stream: the job, its transcript, its call, the machine.
    const live = fold(a.events());
    const after = await snapshotOf(s, session);
    assert.equal(live.get(`job:${job}`).state, "succeeded");
    assert.deepEqual(live.get(`job:${job}`), after.session.jobs[0]);
    const messageIds = [...live.keys()].filter((k) => k.startsWith("message:")).map((k) => k.slice(8)).sort();
    assert.deepEqual(messageIds, after.session.messages.map((m: any) => m.message_id).sort());
    assert.deepEqual(after.session.messages.map((m: any) => JSON.parse(m.content_json).role), ["user", "tool", "assistant"]);
    assert.equal(live.get(`call:${job}/r-1`).status, "completed");
    assert.equal(s.count("run"), 1);

    // Reconnect from the middle: only later events, and the fold ends in the same state.
    const b = stream(s, { lastEventId: mid });
    await b.until(() => (b.messages.at(-1)?.id ?? 0) >= after.cursor);
    await b.close();
    assert.ok(b.messages.every((m) => m.id === undefined || m.id > mid), "a replay starts after Last-Event-ID");
    assert.ok(increasing(b.messages.map((m) => m.id!).filter((id) => id !== undefined)));
    const firstHalf = a.events().filter((e: any) => e.event_id <= mid);
    const resumed = fold([...firstHalf, ...b.events()]);
    assert.deepEqual(resumed.get(`job:${job}`), live.get(`job:${job}`));
    assert.deepEqual([...resumed.keys()].filter((k) => k.startsWith("message:")).sort(), [...live.keys()].filter((k) => k.startsWith("message:")).sort());
  } finally { await s.close(); }
});

test("P6-A the queue, cancel requests, machine state and delegated children all reach the feed", { timeout: 90000 }, async () => {
  const s = await startScenario({ scripts: {
    long: bash("l-1", "echo long >> marker.log; sleep 30"),
    q2: bash("q2-1", "echo q2 >> marker.log"),
    q3: bash("q3-1", "echo q3 >> marker.log"),
    plan: [{ tool: "delegate", arguments: { worker_id: "w", prompt: "child", delegation_key: "c" }, id: "d-1" }, { text: "planned" }],
    child: bash("c-1", "echo child >> marker.log"),
  } });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const { cursor } = await snapshotOf(s, session);
    const feed = stream(s, { after: cursor });
    const view = () => fold(feed.events());
    const long = await s.submit(session, "long");
    await feed.until(() => view().get(`call:${long}/l-1`)?.status === "dispatched");
    const q2 = await s.submit(session, "q2");
    const q3 = await s.submit(session, "q3");
    await feed.until(() => view().get(`job:${q3}`)?.queue_position === 2);
    assert.equal(view().get(`job:${q2}`).queue_position, 1);
    assert.equal(view().get("worker:w").queued_jobs, 2);
    assert.equal(view().get("worker:w").active_job_id, long);

    // Cancelling the queued job moves the one behind it up, visibly.
    assert.equal((await s.api("POST", `/api/jobs/${q2}/cancel`)).json().state, "cancelled");
    await feed.until(() => view().get(`job:${q3}`)?.queue_position === 1);

    // A running job shows the request before it is proven stopped.
    await s.api("POST", `/api/jobs/${long}/cancel`);
    await feed.until(() => view().get(`job:${long}`)?.cancel_requested === 1);
    await feed.until(() => view().get(`job:${long}`)?.state === "cancelled" && view().get(`job:${q3}`)?.state === "succeeded");
    assert.ok(view().get(`call:${long}/l-1`).cancel_sent_at, "the stop request is visible on the call");

    // Delegated children appear, live, on the parent the Main session shows.
    const mainId = (await snapshotOf(s)).main_session_id;
    const parent = await s.submit(mainId, "plan");
    await feed.until(() => view().get(`job:${parent}`)?.state === "succeeded" && view().get(`job:${parent}`)?.children?.[0]?.result != null);
    const p = view().get(`job:${parent}`);
    assert.equal(p.children[0].state, "succeeded");
    assert.equal(p.children[0].delegation_id, "c");
    assert.equal(p.children[0].result.outcome, "succeeded");
    assert.deepEqual(p.children_summary, { total: 1, succeeded: 1, failed: 0, needs_attention: 0, open: 0 });

    // Online and schedulable are separate, and going offline is an event.
    await s.stopWorker();
    await feed.until(() => view().get("worker:w")?.online === 0);
    assert.equal(view().get("worker:w").schedulable, false);
    await feed.close();
  } finally { await s.close(); }
});

test("P6-A an expired or foreign cursor resets; the feed and history need a login", { timeout: 30000 }, async () => {
  const s = await startScenario({ scripts: {} });
  try {
    const { cursor } = await snapshotOf(s);
    assert.ok(cursor > 0);
    // Retention removed everything so far: an old cursor cannot be replayed.
    pruneEvents(s.main.db, Date.now, 0);
    const old = stream(s, { after: 0 });
    await old.done;
    assert.deepEqual(old.messages.map((m) => [m.event, m.data.reason]), [["reset", "cursor_expired"]]);
    const foreign = stream(s, { after: cursor + 1000 });
    await foreign.done;
    assert.equal(foreign.messages[0].event, "reset");
    const fresh = await snapshotOf(s);
    assert.equal(fresh.cursor, cursor, "a snapshot after retention still gives a usable cursor");
    const ok = stream(s, { after: fresh.cursor });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ok.ended, false);
    assert.equal(ok.status, 200);

    // Without a login: no stream, no snapshot, no history, no logs.
    const anonymous = await fetch(`http://127.0.0.1:${s.main.port}/api/events?after=${fresh.cursor}`);
    assert.equal(anonymous.status, 401);
    for (const url of [`/api/snapshot`, `/api/sessions/${fresh.main_session_id}/messages`, `/api/jobs/x/calls/y/logs`])
      assert.equal((await s.main.app.inject({ method: "GET", url })).statusCode, 401, url);

    // Logging out ends an open stream at its next delivery.
    await s.api("POST", "/auth/logout");
    s.main.db.prepare("UPDATE sessions SET title='changed' WHERE session_id=?").run(fresh.main_session_id);
    await ok.until(() => ok.ended, 5000);
    assert.ok(!ok.events().some((e: any) => e.kind === "session"), "nothing is delivered after logout");
  } finally { await s.close(); }
});

test("P6-A drafts: streamed text is visible, an interrupted one is marked, a committed one is never shown twice", { timeout: 60000 }, async () => {
  const long = "This answer streams slowly so that it can be seen and interrupted before it commits. ".repeat(4);
  const s = await startScenario({ scripts: {
    slow: [{ text: long, tokens_per_second: 20 }],
    crash: [{ text: long, tokens_per_second: 20 }],
    fast: [{ text: "short answer", tokens_per_second: 200 }],
  } });
  try {
    const mainId = (await snapshotOf(s)).main_session_id;
    const drafts = (job: string) => s.all("SELECT * FROM model_drafts WHERE job_id=? ORDER BY created_at", job);
    const assistant = (job: string) => s.all("SELECT * FROM messages WHERE job_id=? AND json_extract(content_json,'$.role')='assistant'", job);

    // Cancelled mid-stream: the draft stays, marked interrupted, and nothing commits.
    const slow = await s.submit(mainId, "slow");
    await s.until(() => drafts(slow)[0]?.state === "streaming" && drafts(slow)[0].text.length > 0);
    const seen = await snapshotOf(s, mainId);
    assert.equal(seen.session.drafts[0].state, "streaming");
    await s.api("POST", `/api/jobs/${slow}/cancel`);
    await s.until(() => s.state(slow) === "cancelled");
    assert.equal(drafts(slow)[0].state, "interrupted");
    assert.ok(long.startsWith(drafts(slow)[0].text) && drafts(slow)[0].text.length < long.length, "the partial text is kept");
    assert.equal(assistant(slow).length, 0);

    // The main node dies mid-stream: after a restart the draft is interrupted and the job runs again once.
    const crash = await s.submit(mainId, "crash");
    await s.until(() => drafts(crash)[0]?.text.length > 0);
    await s.stopMain();
    await s.startMain();
    await s.until(() => s.state(crash) === "succeeded", 30000);
    const crashDrafts = drafts(crash);
    assert.deepEqual(crashDrafts.map((d: any) => d.state), ["interrupted", "committed"]);
    assert.equal(assistant(crash).length, 1, "the committed answer appears once");

    // Committed: the message carries the text, the draft is no longer shown.
    const fast = await s.submit(mainId, "fast");
    await s.until(() => s.state(fast) === "succeeded");
    assert.deepEqual(drafts(fast).map((d: any) => [d.state, d.text]), [["committed", ""]]);
    assert.equal(assistant(fast).length, 1);
    const after = await snapshotOf(s, mainId);
    assert.deepEqual(after.session.drafts.map((d: any) => [d.job_id, d.state]), [[slow, "interrupted"], [crash, "interrupted"]]);
  } finally { await s.close(); }
});

test("P6-A a log states each gap: chunks the worker logged that this node does not hold", { timeout: 30000 }, async () => {
  const s = await startScenario({ scripts: {} });
  try {
    const { main_session_id: main } = await snapshotOf(s);
    const db = s.main.db;
    db.prepare("INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,state,created_at) VALUES('gj',?,'gap','h','failed',0)").run(main);
    db.prepare("INSERT INTO runtime_turns VALUES('gj','t','{}','h',0)").run();
    db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES('gj','t','gc',1,'h','bash','{}','completed')").run();
    // Four chunks of ten bytes were logged; the worker expired before chunks 1 and 3 arrived.
    db.prepare("INSERT INTO call_log_state(job_id,call_id,stream,chunks,bytes_total,state) VALUES('gj','gc','stdout',4,40,'expired')").run();
    for (const [seq, offset] of [[0, 0], [2, 20]]) db.prepare("INSERT INTO call_logs VALUES('gj','gc','stdout',?,?,?)").run(seq, offset, Buffer.alloc(10, 97));
    const page = (await s.api("GET", "/api/jobs/gj/calls/gc/logs?stream=stdout")).json();
    assert.equal(page.state, "expired");
    assert.deepEqual(page.items.map((i: any) => i.seq), [0, 2]);
    assert.deepEqual(page.gaps, [
      { from_seq: 1, to_seq: 1, from_offset: 10, missing_bytes: 10 },
      { from_seq: 3, to_seq: 3, from_offset: 30, missing_bytes: 10 },
    ]);
    const snap = await snapshotOf(s, main);
    assert.deepEqual(snap.session.logs[0].gaps, page.gaps, "the snapshot shows the same gaps");
  } finally { await s.close(); }
});
