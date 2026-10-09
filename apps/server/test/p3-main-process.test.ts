// P3-C acceptance: the main node runs as its own process and is SIGKILLed at
// each commit point. Recovery must come from SQLite alone, without asking the
// model again or repeating the worker side effect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { MainFaultPoint } from "../src/fault.js";
import { adminClient, expectMainRefused, processScenario } from "./support/main-process.js";

const scripts = {
  crash: [{ tool: "bash", arguments: { command: "echo crash >> marker.log; sleep 1" }, id: "crash-1" }, { text: "done" }],
  next: [{ tool: "bash", arguments: { command: "echo next >> marker.log" }, id: "next-1" }, { text: "done" }],
};

for (const point of ["before_dispatch", "after_dispatch", "after_result_commit"] satisfies MainFaultPoint[]) {
  test(`P3-C main process SIGKILL ${point}: restart resumes from SQLite without repeating the model turn or the effect`, { timeout: 90000 }, async (t) => {
    const s = await processScenario(scripts);
    try {
      await s.start({ WP_MAIN_FAULT: point });
      s.startWorker();
      await s.until(() => s.one("SELECT reconciled FROM workers WHERE worker_id='w'")?.reconciled === 1);
      const post = await adminClient(() => s.main.port, s.password);
      const session = (await (await post("/api/sessions", { worker_id: "w", workspace_id: "repo" })).json()).session_id;
      const job = (await (await post(`/api/sessions/${session}/messages`, { client_request_id: "crash", message: "crash" })).json()).job_id;
      t.diagnostic(`job=${job} call=crash-1`);

      const killed = s.main;
      await killed.exited;
      assert.equal(killed.child.signalCode, "SIGKILL");
      assert.match(killed.stderr(), new RegExp(`fault injection: SIGKILL at ${point}`));
      const status = s.one("SELECT status FROM runtime_calls WHERE call_id='crash-1'").status;
      assert.equal(status, { before_dispatch: "committed", after_dispatch: "dispatched", after_result_commit: "completed" }[point]);

      // The owner lock fails closed after an unclean exit until an operator clears it.
      const refused = await expectMainRefused({ dataDir: s.dataDir, scriptFile: s.scriptFile });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /EEXIST/);
      rmSync(join(s.dataDir, "main.lock"), { recursive: true });

      await s.start();
      await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", job).state === "succeeded");
      assert.equal(s.count("crash"), 1, "one side effect");
      assert.equal(s.one("SELECT count(*) n FROM runtime_turns WHERE job_id=?", job).n, 1, "the tool turn was not regenerated");
      assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"tool\"%'", job).n, 1, "one tool message");
      assert.equal(s.one("SELECT count(*) n FROM messages WHERE job_id=? AND content_json LIKE '%\"role\":\"assistant\"%'", job).n, 1, "one final answer");
      assert.equal(s.one("SELECT blocked FROM workers").blocked, 0);
      // The slot is released right after the job settles, but a tick later than
      // the state flip; wait for it instead of racing the coordinator.
      await s.until(() => s.one("SELECT active_job_id FROM worker_slots").active_job_id === null);
      if (point === "after_result_commit")
        assert.ok(s.proxy.frames.filter((f) => f.type === "tool_ack" && f.call_id === "crash-1").length >= 1, "the lost ACK was sent after restart");

      const repost = await adminClient(() => s.main.port, s.password);
      const next = (await (await repost(`/api/sessions/${session}/messages`, { client_request_id: "next", message: "next" })).json()).job_id;
      await s.until(() => s.one("SELECT state FROM jobs WHERE job_id=?", next).state === "succeeded");
      assert.equal(s.count("crash"), 1);
      assert.equal(s.count("next"), 1);
    } finally { await s.close(); }
  });
}

test("P3-C a second main process on the same data directory is refused while the first keeps serving", { timeout: 60000 }, async (t) => {
  const s = await processScenario(scripts);
  try {
    const first = await s.start();
    t.diagnostic(`first pid=${first.child.pid}`);
    const second = await expectMainRefused({ dataDir: s.dataDir, scriptFile: s.scriptFile });
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /EEXIST/);
    assert.ok((await fetch(`http://127.0.0.1:${first.port}/health`)).ok, "the first instance still serves");
    assert.equal(JSON.parse(readFileSync(join(s.dataDir, "main.lock/owner.json"), "utf8")).pid, first.child.pid, "the lock still names the first instance");
    first.child.kill("SIGTERM");
    await first.exited;
    assert.equal(existsSync(join(s.dataDir, "main.lock")), false, "a clean shutdown releases the lock");
    await s.start();
  } finally { await s.close(); }
});
