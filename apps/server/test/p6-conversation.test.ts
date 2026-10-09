// P6-D acceptance: a job carries the earlier finished exchanges of its session,
// fixed when it first runs. In-process main node, a real Rust worker and a
// scripted model that records the messages it is given.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScriptStep } from "../src/execution.js";
import { startScenario } from "./support/main-node.js";

type Scenario = Awaited<ReturnType<typeof startScenario>>;
const bash = (id: string, command: string): ScriptStep[] => [{ tool: "bash", arguments: { command }, id }, { text: `${id} done` }];
const answer = (text: string): ScriptStep[] => [{ text }];

/** A scenario whose model records, per input, the messages of each run. */
async function recording(scripts: Record<string, ScriptStep[]>, workers?: string[]) {
  const seen = new Map<string, any[][]>();
  const s = await startScenario({ scripts, workers, app: { fakeScript: (job, messages) => {
    seen.set(job.input_text, [...(seen.get(job.input_text) ?? []), structuredClone(messages)]);
    return scripts[job.input_text];
  } } });
  return { s, seen, last: (input: string) => seen.get(input)!.at(-1)! };
}

/** Each message as role and its text, which is what the model reads. */
const said = (messages: any[]) => messages.map((m) => [m.role, m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(" | ")]);
const context = (s: Scenario, job: string) => JSON.parse(s.one("SELECT context_json FROM jobs WHERE job_id=?", job).context_json);
const mainId = async (s: Scenario) => (await s.api("GET", "/api/main")).json().session_id as string;

test("P6-D a follow-up carries the earlier question and answer; another session sees none of it", { timeout: 60000 }, async () => {
  const { s, last } = await recording({
    first: bash("first-1", "echo first >> marker.log"),
    second: answer("second answer"),
    other: answer("other answer"),
  });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const first = await s.submit(session, "first");
    await s.until(() => s.state(first) === "succeeded");
    assert.deepEqual(said(last("first")), [["user", "first"]], "the first message carries nothing");
    assert.deepEqual(context(s, first), { jobs: [], omitted: 0 });

    const second = await s.submit(session, "second");
    await s.until(() => s.state(second) === "succeeded");
    assert.deepEqual(said(last("second")), [["user", "first"], ["assistant", "first-1 done"], ["user", "second"]]);
    assert.ok(last("second").every((m) => !m.content.some((c: any) => c.type === "toolCall")) && last("second").every((m) => m.role !== "toolResult"), "earlier tool calls stay out");
    assert.equal(s.count("first"), 1, "the earlier command is not run again");

    const view = (await s.api("GET", `/api/sessions/${session}/jobs`)).json();
    assert.deepEqual(view.find((j: any) => j.job_id === second).context, { jobs: 1, omitted: 0 });

    const other = await s.createSession();
    const job = await s.submit(other, "other");
    await s.until(() => s.state(job) === "succeeded");
    assert.deepEqual(said(last("other")), [["user", "other"]], "another session on the same machine shares nothing");
  } finally { await s.close(); }
});

test("P6-D a cancelled job is carried as unfinished; a job cancelled while queued is not carried", { timeout: 90000 }, async () => {
  const { s, last } = await recording({
    long: bash("long-1", "echo long >> marker.log; sleep 30"),
    skipped: answer("never"),
    next: answer("next answer"),
  });
  try {
    s.startWorker(); await s.ready();
    const session = await s.createSession();
    const long = await s.submit(session, "long");
    const skipped = await s.submit(session, "skipped");
    const next = await s.submit(session, "next");
    await s.until(() => s.count("long") === 1);
    assert.equal((await s.api("POST", `/api/jobs/${skipped}/cancel`)).json().state, "cancelled");
    await s.api("POST", `/api/jobs/${long}/cancel`);
    await s.until(() => s.state(next) === "succeeded");
    const endReason = s.one("SELECT end_reason FROM jobs WHERE job_id=?", long).end_reason;
    assert.deepEqual(said(last("next")), [
      ["user", "long"],
      ["assistant", `[This task did not finish: cancelled${endReason ? ` (${endReason})` : ""}.]`],
      ["user", "next"],
    ]);
    assert.deepEqual(context(s, next).jobs.map((j: any) => j.job_id), [long], "the job that never ran is left out");
  } finally { await s.close(); }
});

test("P6-D the carried context is fixed: a restart rebuilds it byte for byte, later jobs do not change it", { timeout: 90000 }, async () => {
  const slow = "slow answer ".repeat(40);
  const { s, seen } = await recording({
    m1: answer("m1 answer"),
    crash: [{ text: slow, tokens_per_second: 40 }],
    m3: answer("m3 answer"),
  });
  try {
    const main = await mainId(s);
    const m1 = await s.submit(main, "m1");
    await s.until(() => s.state(m1) === "succeeded");
    const crash = await s.submit(main, "crash");
    await s.until(() => (s.one("SELECT text FROM model_drafts WHERE job_id=?", crash)?.text.length ?? 0) > 0);
    const fixed = s.one("SELECT context_json FROM jobs WHERE job_id=?", crash).context_json;
    await s.stopMain();
    await s.startMain();
    await s.until(() => s.state(crash) === "succeeded", 30000);
    const runs = seen.get("crash")!;
    assert.equal(runs.length, 2, "the job ran again after the restart");
    assert.equal(JSON.stringify(runs[1]), JSON.stringify(runs[0]), "the rebuilt transcript is identical");
    assert.deepEqual(said(runs[1]), [["user", "m1"], ["assistant", "m1 answer"], ["user", "crash"]]);

    const m3 = await s.submit(main, "m3");
    await s.until(() => s.state(m3) === "succeeded");
    assert.equal(s.one("SELECT context_json FROM jobs WHERE job_id=?", crash).context_json, fixed, "a finished job keeps its context");
    assert.deepEqual(said(seen.get("m3")!.at(-1)!).map(([role]) => role), ["user", "assistant", "user", "assistant", "user"]);
  } finally { await s.close(); }
});

test("P6-D past the size limit the oldest exchanges are left out and the model is told", { timeout: 60000 }, async () => {
  const { s, last } = await recording({ q1: answer("a1"), q2: answer("a2"), q3: answer("a3"), q4: answer("a4") });
  const before = process.env.SESSION_CONTEXT_CHARS;
  try {
    const main = await mainId(s);
    for (const q of ["q1", "q2", "q3"]) {
      const job = await s.submit(main, q);
      await s.until(() => s.state(job) === "succeeded");
    }
    // One exchange is about 60 characters of content: two fit, the third does not.
    process.env.SESSION_CONTEXT_CHARS = "130";
    const q4 = await s.submit(main, "q4");
    await s.until(() => s.state(q4) === "succeeded");
    assert.deepEqual(said(last("q4")), [
      ["user", "[1 earlier exchange of this session is not included.] | q2"],
      ["assistant", "a2"], ["user", "q3"], ["assistant", "a3"], ["user", "q4"],
    ]);
    assert.equal(context(s, q4).omitted, 1);
    const view = (await s.api("GET", `/api/sessions/${main}/jobs`)).json();
    assert.deepEqual(view.find((j: any) => j.job_id === q4).context, { jobs: 2, omitted: 1 });
  } finally {
    if (before === undefined) delete process.env.SESSION_CONTEXT_CHARS; else process.env.SESSION_CONTEXT_CHARS = before;
    await s.close();
  }
});

test("P6-D a child session's first follow-up carries the delegated prompt and the child's answer", { timeout: 60000 }, async () => {
  const { s, last } = await recording({
    plan: [{ tool: "delegate", arguments: { worker_id: "w", prompt: "child task" }, id: "d-1" }, { text: "delegated" }],
    "child task": answer("child answer"),
    "follow up": answer("follow answer"),
  });
  try {
    s.startWorker(); await s.ready();
    const main = await mainId(s);
    const parent = await s.submit(main, "plan");
    await s.until(() => s.state(parent) === "succeeded");
    const child = s.one("SELECT job_id,session_id FROM jobs WHERE parent_job_id=?", parent);
    assert.deepEqual(said(last("child task")), [["user", "child task"]], "a child starts with only its prompt");
    const follow = await s.submit(child.session_id, "follow up");
    await s.until(() => s.state(follow) === "succeeded");
    assert.deepEqual(said(last("follow up")), [["user", "child task"], ["assistant", "child answer"], ["user", "follow up"]]);
    assert.ok(!said(last("follow up")).some(([, text]) => text.includes("plan") || text.includes("delegated")), "nothing from the main session");
  } finally { await s.close(); }
});
