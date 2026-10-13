import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { startScenario } from "./support/main-node.js";

test("O2-KR2 diagnosis → approve → execute → verify", { timeout: 120000 }, async () => {
  const scripts = {
    diag: [{ text: "Diagnosis complete." }],
  };
  const s = await startScenario({
    scripts,
    app: {
      fakeScript: (job) => {
        const text = job.input_text as string;
        if (text.startsWith("验证已执行动作")) return [{ text: "Verification step acknowledged." }];
        return scripts[text as keyof typeof scripts];
      },
    },
  });
  const victim = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
  victim.unref();
  const pid = victim.pid!;
  try {
    s.startWorker();
    await s.ready();
    const sessionRes = await s.api("POST", "/api/sessions", {
      worker_id: "w",
      workspace_id: "repo",
      execution_mode: "diagnosis",
    });
    assert.equal(sessionRes.statusCode, 201, sessionRes.body);
    const sessionId = sessionRes.json().session_id as string;
    const diagJob = await s.submit(sessionId, "diag");
    await s.until(() => s.state(diagJob) === "succeeded");

    const killCommand = `kill ${pid}`;
    const propose = await s.api("POST", `/api/sessions/${sessionId}/approved-actions`, {
      tool: "bash",
      arguments: { command: killCommand },
      verify_command: "df -h /",
      diagnosis_job_id: diagJob,
    });
    assert.equal(propose.statusCode, 201, propose.body);
    const actionId = propose.json().approved_action_id as string;
    assert.equal((await s.api("POST", `/api/approved-actions/${actionId}/approve`, {})).statusCode, 200);

    const execute = await s.api("POST", `/api/approved-actions/${actionId}/execute`, {});
    assert.equal(execute.statusCode, 202, execute.body);
    const executeJobId = execute.json().job_id as string;
    await s.until(() => s.state(executeJobId) === "succeeded");
    const afterExecute = (await s.api("GET", `/api/approved-actions/${actionId}`)).json();
    assert.equal(afterExecute.state, "executed");

    const verify = await s.api("POST", `/api/approved-actions/${actionId}/verify`, {});
    assert.equal(verify.statusCode, 202, verify.body);
    const verifyJobId = verify.json().job_id as string;
    await s.until(() => s.state(verifyJobId) === "succeeded");
    const afterVerify = (await s.api("GET", `/api/approved-actions/${actionId}`)).json();
    assert.equal(afterVerify.state, "verified");

    const verifyCall = s.one("SELECT status,request_hash FROM runtime_calls WHERE job_id=? AND call_id=?", verifyJobId, `verify-${verifyJobId}`);
    assert.equal(verifyCall.status, "completed");
    assert.ok(verifyCall.request_hash);
  } finally {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone after approved kill */
    }
    await s.close();
  }
});
