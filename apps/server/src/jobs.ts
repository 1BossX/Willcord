import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Budget, ToolRecord } from "./execution.js";
import { deviceRequiresDiagnosis } from "./device-policy.js";

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_PROMPT = 32000;
const MAX_DEPENDENCIES = 16;

/** The root a job counts against: its limits, its deadline once it ran. */
type Root = { root_job_id: string; max_tool_calls: number | null; max_tokens: number | null; max_runtime_secs: number | null; deadline_at: number | null };
type Session = { session_id: string; kind: "main" | "worker"; worker_id: string | null };

export function nextQueueSeq(db: Database.Database) {
  return Number((db.prepare("SELECT COALESCE(MAX(queue_seq),0)+1 n FROM jobs").get() as { n: number }).n);
}

/** Queued while the worker can take calls, otherwise waiting for it to come back. */
export function readyState(db: Database.Database, workerId: string) {
  const worker = db.prepare("SELECT online,reconciled,blocked FROM workers WHERE worker_id=?").get(workerId) as { online: number; reconciled: number; blocked: number } | undefined;
  return worker?.online && worker.reconciled && !worker.blocked ? "queued" : "waiting_worker";
}

/**
 * Inside a transaction: a job and its user message. A job without a parent is
 * its own budget root; a delegated job shares its root's limits and deadline.
 * A worker job joins its worker's FIFO only when `ready`; until then it holds
 * no queue position. A main job never takes a worker slot.
 */
export function createJob(db: Database.Database, now: () => number, o: {
  session: Session; clientRequestId: string; message: string; requestHash: string; budget: Budget;
  root?: Root; parentJobId?: string; delegationId?: string; ready?: boolean;
}) {
  const main = o.session.kind === "main";
  const ready = o.ready ?? true;
  const jobId = randomUUID();
  const state = main || !ready ? "queued" : readyState(db, o.session.worker_id!);
  const queueSeq = main || !ready ? null : nextQueueSeq(db);
  const waitUntil = queueSeq === null ? null : now() + Number(process.env.WORKER_WAIT_MS ?? 86400000);
  const limits = o.root ?? { root_job_id: jobId, max_tool_calls: o.budget.maxToolCalls, max_tokens: o.budget.maxTokens, max_runtime_secs: o.budget.maxRuntimeSecs, deadline_at: null };
  db.prepare(`INSERT INTO jobs(job_id,session_id,client_request_id,request_hash,input_text,worker_id,queue_seq,state,created_at,wait_until,
    parent_job_id,delegation_id,root_job_id,max_tool_calls,max_tokens,max_runtime_secs,deadline_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(jobId, o.session.session_id, o.clientRequestId, o.requestHash, o.message, o.session.worker_id, queueSeq, state, now(), waitUntil,
      o.parentJobId ?? null, o.delegationId ?? null, limits.root_job_id, limits.max_tool_calls, limits.max_tokens, limits.max_runtime_secs, limits.deadline_at);
  if (!o.root) db.prepare("INSERT INTO budget_roots(root_job_id) VALUES(?)").run(jobId);
  db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,?,?,COALESCE(MAX(seq),0)+1,? FROM messages WHERE session_id=?").run(randomUUID(), o.session.session_id, jobId, JSON.stringify({ role: "user", content: o.message }), o.session.session_id);
  if (!main) db.prepare("INSERT INTO worker_slots(worker_id) VALUES (?) ON CONFLICT(worker_id) DO NOTHING").run(o.session.worker_id);
  return { job_id: jobId, state, queue_seq: queueSeq };
}

/** The single Main Agent session, created on first use. */
export function mainSession(db: Database.Database, now: () => number) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT * FROM sessions WHERE kind='main' ORDER BY created_at LIMIT 1").get();
    if (existing) return existing as Session & Record<string, unknown>;
    db.prepare("INSERT INTO sessions(session_id,kind,created_at,title) VALUES(?,'main',?,'Main Agent')").run(randomUUID(), now());
    return db.prepare("SELECT * FROM sessions WHERE kind='main'").get() as Session & Record<string, unknown>;
  }).immediate();
}

export type DelegateArgs = { worker_id?: unknown; workspace_id?: unknown; prompt?: unknown; delegation_key?: unknown; depends_on?: unknown; verify?: unknown };
export type Delegated = { record: ToolRecord; workerId?: string; queued?: boolean };

const refuse = (error: string, extra: Record<string, unknown> = {}): Delegated => ({ record: { ok: false, result: { error, ...extra } } });

/**
 * Inside a transaction: create a child session and job for a delegate call.
 * The parent is the job running the call, never an argument. The delegation ID
 * is the model's key when it gave one, else the call ID; a repeat with the same
 * content returns the original child, different content is a conflict.
 */
export function delegate(db: Database.Database, now: () => number, budget: Budget, parent: { job_id: string; root_job_id: string }, callId: string, args: DelegateArgs): Delegated {
  if (typeof args.worker_id !== "string" || !args.worker_id) return refuse("worker_id_required");
  if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > MAX_PROMPT) return refuse("invalid_prompt");
  if (args.workspace_id !== undefined && (typeof args.workspace_id !== "string" || !args.workspace_id)) return refuse("invalid_workspace_id");
  if (args.delegation_key !== undefined && (typeof args.delegation_key !== "string" || !args.delegation_key || args.delegation_key.length > 128)) return refuse("invalid_delegation_key");
  if (args.verify !== undefined && (typeof args.verify !== "string" || !args.verify.trim() || args.verify.length > 4000)) return refuse("invalid_verify");
  const dependsOn = args.depends_on ?? [];
  if (!Array.isArray(dependsOn) || dependsOn.length > MAX_DEPENDENCIES || dependsOn.some((d) => typeof d !== "string" || !d) || new Set(dependsOn).size !== dependsOn.length) return refuse("invalid_depends_on");
  const workspace = db.prepare(args.workspace_id === undefined
    ? "SELECT * FROM workspaces WHERE worker_id=? AND is_default=1"
    : "SELECT * FROM workspaces WHERE worker_id=? AND workspace_id=?").get(...[args.worker_id, args.workspace_id].filter((v) => v !== undefined)) as any;
  if (!workspace) return refuse("worker_or_workspace_not_found", { worker_id: args.worker_id, workspace_id: args.workspace_id ?? null });

  const delegationId = (args.delegation_key as string | undefined) ?? callId;
  // A dependency names a sibling's delegation key or any job of the same root.
  const prerequisites: Array<{ job_id: string; state: string }> = [];
  for (const ref of dependsOn as string[]) {
    const job = (db.prepare("SELECT job_id,state,root_job_id FROM jobs WHERE parent_job_id=? AND delegation_id=?").get(parent.job_id, ref)
      ?? db.prepare("SELECT job_id,state,root_job_id FROM jobs WHERE job_id=?").get(ref)) as { job_id: string; state: string; root_job_id: string } | undefined;
    if (!job || job.root_job_id !== parent.root_job_id || job.job_id === parent.job_id) return refuse("dependency_not_in_task", { depends_on: ref });
    prerequisites.push(job);
  }
  const prerequisiteIds = [...new Set(prerequisites.map((p) => p.job_id))].sort();
  const verify = args.verify as string | undefined;
  const requestHash = hash({ worker_id: args.worker_id, workspace_id: workspace.workspace_id, prompt: args.prompt, depends_on: prerequisiteIds, verify: verify ?? null });

  const existing = db.prepare("SELECT job_id,session_id,state,request_hash,worker_id FROM jobs WHERE parent_job_id=? AND delegation_id=?").get(parent.job_id, delegationId) as any;
  if (existing) {
    if (existing.request_hash !== requestHash) return refuse("delegation_conflict", { delegation_id: delegationId, job_id: existing.job_id });
    return { record: { ok: true, result: { job_id: existing.job_id, session_id: existing.session_id, delegation_id: delegationId, worker_id: existing.worker_id, state: existing.state, duplicate: true } } };
  }
  // A new job can only point at jobs that already exist, so no cycle can form.
  const failed = prerequisites.find((p) => TERMINAL.has(p.state) && p.state !== "succeeded");
  if (failed) return refuse("dependency_failed", { depends_on: failed.job_id, state: failed.state });

  const root = db.prepare("SELECT root_job_id,max_tool_calls,max_tokens,max_runtime_secs,deadline_at FROM jobs WHERE job_id=?").get(parent.root_job_id) as Root;
  // A device locked to diagnosis runs only diagnosis; a delegated task becomes one (#86).
  const forcedDiagnosis = deviceRequiresDiagnosis(db, args.worker_id);
  const sessionId = randomUUID();
  db.prepare("INSERT INTO sessions(session_id,kind,worker_id,workspace_id,workspace_version,repo_id,path,created_at,title,parent_job_id,delegation_id,execution_mode) VALUES(?,'worker',?,?,?,?,?,?,?,?,?,?)")
    .run(sessionId, args.worker_id, workspace.workspace_id, workspace.config_version, workspace.repo_id, workspace.path, now(), Array.from(args.prompt.trim().replace(/\s+/g, " ")).slice(0, 80).join(""), parent.job_id, delegationId, forcedDiagnosis ? "diagnosis" : null);
  const ready = prerequisites.every((p) => p.state === "succeeded");
  const created = createJob(db, now, {
    session: { session_id: sessionId, kind: "worker", worker_id: args.worker_id }, clientRequestId: `delegation:${parent.job_id}:${delegationId}`,
    message: args.prompt, requestHash, budget, root, parentJobId: parent.job_id, delegationId, ready,
  });
  if (verify) db.prepare("UPDATE jobs SET verify_command=? WHERE job_id=?").run(verify, created.job_id);
  for (const id of prerequisiteIds) db.prepare("INSERT INTO job_dependencies(job_id,depends_on_job_id) VALUES(?,?)").run(created.job_id, id);
  db.prepare("INSERT INTO events(created_at,content_json) VALUES(?,?)").run(now(), JSON.stringify({ type: "job_delegated", parent_job_id: parent.job_id, job_id: created.job_id, session_id: sessionId, delegation_id: delegationId, worker_id: args.worker_id, depends_on: prerequisiteIds }));
  return {
    record: { ok: true, result: { job_id: created.job_id, session_id: sessionId, delegation_id: delegationId, worker_id: args.worker_id, workspace_id: workspace.workspace_id, state: created.state, depends_on: prerequisiteIds, verify: verify ?? null, waiting_for_dependencies: !ready } },
    workerId: args.worker_id, queued: created.state === "queued" && ready,
  };
}
