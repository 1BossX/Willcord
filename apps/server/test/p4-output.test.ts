// P4-A through the main node: what the model sees of bash output, how missing
// chunks are fetched, and how stored output is released on both sides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startScenario } from "./support/main-node.js";

const loud = (callId: string) => [
  { tool: "bash" as const, arguments: { command: "head -c 200000 /dev/zero | tr '\\0' b; echo warn >&2" }, id: callId },
  { text: "done" },
];

test("P4-A the model sees the first 64 KiB of each stream; lost live chunks are fetched and the log completes", { timeout: 60000 }, async (t) => {
  // Every live chunk below seq 3 is lost once; the result must wait for the fetch.
  const seen = new Set<string>();
  const s = await startScenario({
    scripts: { loud: loud("loud-1") },
    drop: (direction, f) => {
      if (direction !== "to_main" || f.type !== "tool_log" || f.seq >= 3) return false;
      const k = `${f.stream}/${f.seq}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  });
  try {
    s.startWorker();
    await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "loud");
    await s.until(() => s.state(job) === "succeeded");
    t.diagnostic(`job=${job} call=loud-1`);
    const record = JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='loud-1'").result_json);
    const stdout = record.result.output.stdout;
    assert.equal(stdout.text, "b".repeat(64 * 1024));
    assert.deepEqual([stdout.bytes_shown, stdout.bytes_total, stdout.truncated, stdout.gap], [65536, 200000, true, false]);
    assert.deepEqual([record.result.output.stderr.text, record.result.output.stderr.truncated], ["warn\n", false]);
    assert.ok(s.proxy.frames.some((f) => f.type === "tool_log" && f.dropped), "live chunks were lost");
    assert.ok(s.proxy.frames.some((f) => f.type === "log_fetch"), "the main node fetched them");
    // The tool message carries the same assembled output the model saw.
    const message = JSON.parse(s.one("SELECT content_json FROM messages WHERE job_id=? AND json_extract(content_json,'$.role')='tool'", job).content_json);
    assert.equal(message.content.output.stdout.bytes_shown, 65536);
    // The full log completes in the background and is then released on the worker.
    await s.until(() => s.all("SELECT state FROM call_log_state WHERE call_id='loud-1'").every((r) => r.state === "complete"));
    const stored = s.one("SELECT COUNT(*) n, SUM(length(data)) bytes FROM call_logs WHERE call_id='loud-1' AND stream='stdout'");
    assert.deepEqual([stored.n, stored.bytes], [Math.ceil(200000 / 16384), 200000]);
    const workerLog = join(s.dir, "w-data", "logs", createHash("sha256").update("loud-1").digest("hex"));
    await s.until(() => !existsSync(workerLog));
    // Operators read the stored log page by page.
    const page = await s.main.app.inject({ method: "GET", url: `/api/jobs/${job}/calls/loud-1/logs?stream=stdout&from_seq=12`, headers: { cookie: (await login(s)) } });
    assert.equal(page.statusCode, 200, page.body);
    assert.deepEqual(page.json().items.map((i: any) => i.seq), [12]);
    assert.equal(Buffer.from(page.json().items[0].data, "base64").length, 200000 - 12 * 16384);
  } finally { await s.close(); }
});

test("P4-A a full main node keeps the model's view and marks the rest as dropped", { timeout: 60000 }, async () => {
  const s = await startScenario({ scripts: { loud: loud("cap-1") }, app: { logCapacityBytes: 100_000 } });
  try {
    s.startWorker();
    await s.ready();
    const session = await s.createSession();
    const job = await s.submit(session, "loud");
    await s.until(() => s.state(job) === "succeeded");
    await s.until(() => s.one("SELECT state FROM call_log_state WHERE call_id='cap-1' AND stream='stdout'").state === "complete");
    const state = s.one("SELECT main_truncated,worker_truncated FROM call_log_state WHERE call_id='cap-1' AND stream='stdout'");
    assert.deepEqual(state, { main_truncated: 1, worker_truncated: 0 });
    const head = JSON.parse(s.one("SELECT result_json FROM runtime_calls WHERE call_id='cap-1'").result_json).result.output.stdout;
    assert.equal(head.bytes_shown, 65536, "the model's view is kept despite the limit");
    assert.ok(s.one("SELECT SUM(length(data)) n FROM call_logs").n <= 100_000);
  } finally { await s.close(); }
});

async function login(s: Awaited<ReturnType<typeof startScenario>>) {
  // startScenario keeps its session cookie private; a second login is cheap.
  const response = await s.main.app.inject({ method: "POST", url: "/auth/login", headers: { origin: "https://localhost:8443" }, payload: { password: "p3-fault-admin-password" } });
  return response.headers["set-cookie"]!.toString().split(";")[0];
}
