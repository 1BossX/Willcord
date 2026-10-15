import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { requestHash } from "@willcord/protocol";
import { DEFAULT_BUDGET } from "./execution.js";
import { nextQueueSeq, readyState } from "./jobs.js";
import { DIAGNOSIS_INTERCEPT_PROBE_PATH } from "./diagnosis-policy.js";
import { workerToolRequestFields } from "./approved-action-wire.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

/**
 * The self-check creates a real job on every call, so a burst must not flood
 * the worker queue; the same budget as /auth/login, keyed per client IP.
 */
export const INTERCEPT_CHECK_RATE_LIMIT = { max: 5, timeWindow: 60000 };

function nextSessionMessageSeq(db: Database.Database, sessionId: string) {
  return Number((db.prepare("SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE session_id=?").get(sessionId) as { n: number }).n);
}

/** Trigger a single diagnosis-mode write so the worker refusal is visible in the session timeline. */
export function registerDiagnosisInterceptProbeRoutes(
  app: any,
  db: Database.Database,
  now: () => number,
  wake: (session: { session_id: string; kind: string; worker_id: string | null }) => void,
) {
  app.post(
    "/api/sessions/:session_id/diagnosis-intercept-check",
    { config: { rateLimit: INTERCEPT_CHECK_RATE_LIMIT } },
    async (req: any, reply: any) => {
    const session = db.prepare("SELECT * FROM sessions WHERE session_id=?").get(req.params.session_id) as any;
    if (!session || session.kind !== "worker") return reply.code(404).send({ error: "session_not_found" });
    if (session.execution_mode !== "diagnosis") return reply.code(409).send({ error: "diagnosis_session_required" });
    const jobId = randomUUID();
    const clientRequestId = `diagnosis-intercept:${randomBytes(8).toString("hex")}`;
    const message = "诊断写拦截自检：触发一次受控 write，验证 worker 在诊断模式下拒绝写入。";
    const requestHashJob = hash({ session_id: session.session_id, clientRequestId });
    const state = readyState(db, session.worker_id);
    const queueSeq = nextQueueSeq(db);
    const callId = `intercept-${randomBytes(6).toString("hex")}`;
    const writeArgs = {
      path: DIAGNOSIS_INTERCEPT_PROBE_PATH,
      content: "willcord-diagnosis-intercept-probe",
      expected_hash: "missing",
    };
    db.transaction(() => {
      db.prepare(
        `INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,root_job_id,max_tool_calls,max_tokens,max_runtime_secs)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        jobId,
        session.session_id,
        clientRequestId,
        requestHashJob,
        message,
        session.worker_id,
        queueSeq,
        state,
        now(),
        jobId,
        DEFAULT_BUDGET.maxToolCalls,
        DEFAULT_BUDGET.maxTokens,
        DEFAULT_BUDGET.maxRuntimeSecs,
      );
      db.prepare("INSERT INTO budget_roots(root_job_id) VALUES(?)").run(jobId);
      db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) VALUES(?,?,?,?,?)").run(
        randomUUID(),
        session.session_id,
        jobId,
        nextSessionMessageSeq(db, session.session_id),
        JSON.stringify({ role: "user", content: message }),
      );
      db.prepare("INSERT INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)").run(
        jobId,
        `user:${jobId}`,
        JSON.stringify({ role: "user", content: [{ type: "text", text: message }], timestamp: now() }),
      );
      db.prepare("INSERT INTO worker_slots(worker_id) VALUES (?) ON CONFLICT(worker_id) DO NOTHING").run(session.worker_id);
      const assistant = {
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name: "write", arguments: writeArgs }],
        timestamp: now(),
      };
      const request = workerToolRequestFields({
        worker_id: session.worker_id,
        job_id: jobId,
        call_id: callId,
        call_seq: 1,
        workspace_id: session.workspace_id,
        workspace_version: session.workspace_version,
        tool: "write",
        arguments: writeArgs,
        execution_mode: "diagnosis",
      });
      const digest = requestHash(request);
      db.prepare("INSERT INTO runtime_turns VALUES(?,?,?,?,?)").run(jobId, `intercept:${callId}`, JSON.stringify(assistant), hash(assistant), now());
      db.prepare(
        "INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status,execution_mode) VALUES(?,?,?,?,?,?,?,'committed','diagnosis')",
      ).run(jobId, `intercept:${callId}`, callId, 1, digest, "write", JSON.stringify(writeArgs));
      db.prepare("INSERT INTO runtime_history(job_id,entry_key,turn_key,message_json) VALUES(?,?,?,NULL)").run(
        jobId,
        `intercept-turn:${callId}`,
        `intercept:${callId}`,
      );
    })();
    wake(session);
    return reply.code(202).send({ job_id: jobId, state, call_id: callId });
    },
  );
}
