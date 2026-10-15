import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { requestHash } from "@willcord/protocol";
import type { ExecutionCoordinator } from "./execution.js";
import { createJob, nextQueueSeq, readyState } from "./jobs.js";
import { DEFAULT_BUDGET } from "./execution.js";
import { workerToolRequestFields } from "./approved-action-wire.js";
import { deviceRequiresDiagnosis } from "./device-policy.js";

export type ApprovedActionRow = {
  approved_action_id: string;
  diagnosis_session_id: string;
  worker_id: string;
  tool: "bash";
  arguments_json: string;
  target: string;
  binding_hash: string;
  verify_command: string | null;
  state: "proposed" | "approved" | "executed" | "verified" | "rejected";
  diagnosis_job_id: string | null;
  execute_job_id: string | null;
  verify_job_id: string | null;
};

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export function actionBinding(workerId: string, tool: string, args: Record<string, unknown>) {
  return requestHash({ worker_id: workerId, tool, arguments: args });
}

export function actionTarget(tool: string, args: Record<string, unknown>) {
  if (tool === "bash" && typeof args.command === "string") return args.command.trim();
  return tool;
}

export function nextSessionMessageSeq(db: Database.Database, sessionId: string) {
  return Number((db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE session_id=?").get(sessionId) as { n: number }).n);
}

function insertSessionUserMessage(db: Database.Database, sessionId: string, jobId: string, content: string) {
  db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) VALUES(?,?,?,?,?)").run(
    randomUUID(),
    sessionId,
    jobId,
    nextSessionMessageSeq(db, sessionId),
    JSON.stringify({ role: "user", content }),
  );
}

/** After the sole pre-committed approved call settles, move action/job to terminal state. */
export function settleApprovedExecuteJob(
  db: Database.Database,
  jobId: string,
  approvedActionId: string,
  record: { ok: boolean; result?: any },
  at: number,
) {
  const exitCode = record.result?.exit_code;
  const succeeded = record.ok && (exitCode === undefined || exitCode === 0);
  db.transaction(() => {
    if (succeeded) {
      db.prepare("UPDATE approved_actions SET state='executed',executed_at=? WHERE approved_action_id=? AND state='approved'").run(at, approvedActionId);
      db.prepare("UPDATE jobs SET state='succeeded',end_reason='completed' WHERE job_id=? AND state='running'").run(jobId);
    } else {
      db.prepare("UPDATE jobs SET state='failed',end_reason='approved_action_failed' WHERE job_id=? AND state='running'").run(jobId);
    }
  })();
}

export function isPostApprovalBashShape(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] === "docker" && tokens.length === 3 && tokens[1] === "restart") return true;
  if (tokens[0] === "systemctl" && tokens.length === 3 && tokens[1] === "restart") return true;
  if (tokens[0] === "kill") {
    if (tokens.length === 2 && /^\d+$/.test(tokens[1])) return true;
    if (tokens.length === 3 && ["-TERM", "-HUP", "-INT"].includes(tokens[1]) && /^\d+$/.test(tokens[2])) return true;
  }
  return false;
}

export function registerApprovedActionRoutes(
  app: any,
  db: Database.Database,
  now: () => number,
  _coordinator: ExecutionCoordinator,
  wake: (session: { session_id: string; kind: string; worker_id: string | null }) => void,
) {
  app.post("/api/sessions/:session_id/approved-actions", async (req: any, reply: any) => {
    const body = req.body as {
      tool?: unknown;
      arguments?: unknown;
      verify_command?: unknown;
      diagnosis_job_id?: unknown;
    } | null;
    if (body?.tool === "write") return reply.code(400).send({ error: "write_not_on_post_approval_allowlist" });
    if (body?.tool !== "bash") return reply.code(400).send({ error: "invalid_tool" });
    if (!body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) {
      return reply.code(400).send({ error: "invalid_arguments" });
    }
    const args = body.arguments as Record<string, unknown>;
    if (body.tool === "bash") {
      if (typeof args.command !== "string" || !isPostApprovalBashShape(args.command)) {
        return reply.code(400).send({ error: "command_not_on_post_approval_allowlist" });
      }
    }
    if (body.verify_command !== undefined && (typeof body.verify_command !== "string" || !body.verify_command.trim() || body.verify_command.length > 4000)) {
      return reply.code(400).send({ error: "invalid_verify_command" });
    }
    const session = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(req.params.session_id) as any;
    if (!session || session.kind !== "worker") return reply.code(404).send({ error: "session_not_found" });
    if (session.execution_mode !== "diagnosis") return reply.code(409).send({ error: "diagnosis_session_required" });
    const workerId = session.worker_id as string;
    // A device locked to diagnosis never takes approved writes (#86).
    if (deviceRequiresDiagnosis(db, workerId)) return reply.code(409).send({ error: "device_requires_diagnosis" });
    const binding = actionBinding(workerId, body.tool, args);
    const id = randomBytes(16).toString("hex");
    const diagnosisJobId = typeof body.diagnosis_job_id === "string" ? body.diagnosis_job_id : null;
    db.prepare(
      `INSERT INTO approved_actions(approved_action_id,diagnosis_session_id,worker_id,tool,arguments_json,target,binding_hash,verify_command,state,diagnosis_job_id,proposed_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id,
      session.session_id,
      workerId,
      body.tool,
      JSON.stringify(args),
      actionTarget(body.tool, args),
      binding,
      typeof body.verify_command === "string" ? body.verify_command.trim() : null,
      "proposed",
      diagnosisJobId,
      now(),
    );
    return reply.code(201).send(getAction(db, id));
  });

  app.get("/api/approved-actions/:approved_action_id", async (req: any, reply: any) => {
    const row = getAction(db, req.params.approved_action_id);
    return row ? row : reply.code(404).send({ error: "not_found" });
  });

  app.post("/api/approved-actions/:approved_action_id/approve", async (req: any, reply: any) => {
    const row = getAction(db, req.params.approved_action_id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.state !== "proposed") return reply.code(409).send({ error: "invalid_state", state: row.state });
    // A device locked after the proposal still never takes the write (#86):
    // approve and execute are checked separately, so lifting one gate cannot
    // carry the action through the other.
    if (deviceRequiresDiagnosis(db, row.worker_id)) return reply.code(409).send({ error: "device_requires_diagnosis" });
    db.prepare("UPDATE approved_actions SET state='approved',approved_at=? WHERE approved_action_id=?").run(now(), row.approved_action_id);
    return getAction(db, row.approved_action_id);
  });

  app.post("/api/approved-actions/:approved_action_id/reject", async (req: any, reply: any) => {
    const body = req.body as { reason?: unknown } | null;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 2000) : "";
    const row = getAction(db, req.params.approved_action_id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.state !== "proposed") return reply.code(409).send({ error: "invalid_state", state: row.state });
    db.prepare("UPDATE approved_actions SET state='rejected',rejected_at=?,reject_reason=? WHERE approved_action_id=?").run(now(), reason || null, row.approved_action_id);
    return getAction(db, row.approved_action_id);
  });

  app.post("/api/approved-actions/:approved_action_id/execute", async (req: any, reply: any) => {
    const row = getAction(db, req.params.approved_action_id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.state !== "approved") return reply.code(409).send({ error: "invalid_state", state: row.state });
    if (row.execute_job_id) return reply.code(409).send({ error: "already_executed", execute_job_id: row.execute_job_id });
    // A device locked after the approval never runs the write (#86): the
    // execute gate is checked again here, not only at approve time.
    if (deviceRequiresDiagnosis(db, row.worker_id)) return reply.code(409).send({ error: "device_requires_diagnosis" });
    const session = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(row.diagnosis_session_id) as any;
    const args = JSON.parse(row.arguments_json) as Record<string, unknown>;
    const jobId = randomUUID();
    const clientRequestId = `approved-action:${row.approved_action_id}:execute`;
    const message = `执行已批准的动作（${row.target}）`;
    const requestHashJob = hash({ approved_action_id: row.approved_action_id, phase: "execute" });
    const state = readyState(db, row.worker_id);
    const queueSeq = nextQueueSeq(db);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,approved_action_id,root_job_id,max_tool_calls,max_tokens,max_runtime_secs)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        jobId,
        session.session_id,
        clientRequestId,
        requestHashJob,
        message,
        row.worker_id,
        queueSeq,
        state,
        now(),
        row.approved_action_id,
        jobId,
        DEFAULT_BUDGET.maxToolCalls,
        DEFAULT_BUDGET.maxTokens,
        DEFAULT_BUDGET.maxRuntimeSecs,
      );
      db.prepare("INSERT INTO budget_roots(root_job_id) VALUES(?)").run(jobId);
      insertSessionUserMessage(db, session.session_id, jobId, message);
      db.prepare(
        "INSERT INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)",
      ).run(
        jobId,
        `user:${jobId}`,
        JSON.stringify({ role: "user", content: [{ type: "text", text: message }], timestamp: now() }),
      );
      db.prepare("INSERT INTO worker_slots(worker_id) VALUES (?) ON CONFLICT(worker_id) DO NOTHING").run(row.worker_id);
      const callId = `approved-${row.approved_action_id}`;
      const request = workerToolRequestFields({
        worker_id: row.worker_id,
        job_id: jobId,
        call_id: callId,
        call_seq: 1,
        workspace_id: session.workspace_id,
        workspace_version: session.workspace_version,
        tool: row.tool,
        arguments: args,
        execution_mode: "approved",
        approved_binding_hash: row.binding_hash,
      });
      const digest = requestHash(request);
      db.prepare("INSERT INTO runtime_turns VALUES(?,?,?,?,?)").run(jobId, `approved:${row.approved_action_id}`, "{}", hash(request), now());
      db.prepare(
        "INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status,execution_mode) VALUES(?,?,?,?,?,?,?,'committed','approved')",
      ).run(jobId, `approved:${row.approved_action_id}`, callId, 1, digest, row.tool, JSON.stringify(args));
      db.prepare(
        "INSERT INTO runtime_history(job_id,entry_key,turn_key,message_json) VALUES(?,?,?,NULL)",
      ).run(jobId, `approved-turn:${row.approved_action_id}`, `approved:${row.approved_action_id}`);
      db.prepare("UPDATE approved_actions SET execute_job_id=? WHERE approved_action_id=? AND state='approved'").run(jobId, row.approved_action_id);
    })();
    wake(session);
    return reply.code(202).send({ job_id: jobId, state, approved_action: getAction(db, row.approved_action_id) });
  });

  app.post("/api/approved-actions/:approved_action_id/verify", async (req: any, reply: any) => {
    const body = req.body as { verify_command?: unknown } | null;
    const row = getAction(db, req.params.approved_action_id);
    if (!row) return reply.code(404).send({ error: "not_found" });
    if (row.state !== "executed") return reply.code(409).send({ error: "invalid_state", state: row.state });
    const verify =
      (typeof body?.verify_command === "string" && body.verify_command.trim() ? body.verify_command.trim() : null) ??
      row.verify_command;
    if (!verify) return reply.code(400).send({ error: "verify_command_required" });
    const session = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(row.diagnosis_session_id) as any;
    const jobId = randomUUID();
    const clientRequestId = `approved-action:${row.approved_action_id}:verify`;
    const message = `验证已执行动作（${row.target}）`;
    const state = readyState(db, row.worker_id);
    const queueSeq = nextQueueSeq(db);
    db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,approved_action_id,verify_command,root_job_id,max_tool_calls,max_tokens,max_runtime_secs)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        jobId,
        session.session_id,
        clientRequestId,
        hash({ approved_action_id: row.approved_action_id, phase: "verify", verify }),
        message,
        row.worker_id,
        queueSeq,
        state,
        now(),
        row.approved_action_id,
        verify,
        jobId,
        DEFAULT_BUDGET.maxToolCalls,
        DEFAULT_BUDGET.maxTokens,
        DEFAULT_BUDGET.maxRuntimeSecs,
      );
      db.prepare("INSERT INTO budget_roots(root_job_id) VALUES(?)").run(jobId);
      insertSessionUserMessage(db, session.session_id, jobId, message);
      db.prepare("UPDATE approved_actions SET verify_job_id=? WHERE approved_action_id=?").run(jobId, row.approved_action_id);
    })();
    wake(session);
    return reply.code(202).send({ job_id: jobId, state, approved_action: getAction(db, row.approved_action_id) });
  });

  app.get("/api/approved-actions/acceptance/passes", async () => {
    const passes = db
      .prepare("SELECT pass_number,approved_action_id,outcome,record_json,created_at FROM approved_action_acceptance_passes ORDER BY pass_number")
      .all() as Array<{ pass_number: number; approved_action_id: string; outcome: string; record_json: string; created_at: number }>;
    return {
      passes: passes.map((p) => ({ ...p, record: JSON.parse(p.record_json) })),
      pass_count: passes.length,
      complete: passes.length >= 10 && passes.every((p) => p.outcome === "pass"),
    };
  });

}

export function recordAcceptancePass(
  db: Database.Database,
  passNumber: number,
  approvedActionId: string,
  outcome: "pass" | "fail",
  record: Record<string, unknown>,
  at: number,
) {
  if (!Number.isInteger(passNumber) || passNumber < 1 || passNumber > 10) throw new Error("invalid_pass_number");
  db.prepare(
    "INSERT INTO approved_action_acceptance_passes(pass_number,approved_action_id,outcome,record_json,created_at) VALUES(?,?,?,?,?)",
  ).run(passNumber, approvedActionId, outcome, JSON.stringify(record), at);
}

export function getAction(db: Database.Database, id: string) {
  const row = db.prepare("SELECT * FROM approved_actions WHERE approved_action_id=?").get(id) as ApprovedActionRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    arguments: JSON.parse(row.arguments_json),
  };
}

/** Reject tool commits that diverge from an approved binding on execute jobs. */
export function assertCallMatchesApproval(
  db: Database.Database,
  job: { job_id: string; worker_id: string; approved_action_id?: string | null },
  tool: string,
  args: Record<string, unknown>,
) {
  if (!job.approved_action_id) return;
  const row = db.prepare("SELECT * FROM approved_actions WHERE approved_action_id=?").get(job.approved_action_id) as ApprovedActionRow | undefined;
  if (!row) throw new Error("approved_action_missing");
  if (row.state !== "approved") throw new Error("approved_action_already_consumed");
  if (row.worker_id !== job.worker_id) throw new Error("approved_action_worker_mismatch");
  const expectedArgs = JSON.parse(row.arguments_json) as Record<string, unknown>;
  if (row.tool !== tool || JSON.stringify(expectedArgs) !== JSON.stringify(args)) {
    throw new Error("approved_action_binding_mismatch");
  }
  if (actionBinding(row.worker_id, row.tool, expectedArgs) !== row.binding_hash) {
    throw new Error("approved_action_binding_corrupt");
  }
}
