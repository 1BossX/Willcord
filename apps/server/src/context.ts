import type Database from "better-sqlite3";

/** Characters of earlier exchanges a job may carry, newest first. */
export const DEFAULT_SESSION_CONTEXT_CHARS = 120_000;

/** A carried job with the outcome it had when the context was fixed. */
type Carried = { job_id: string; state: string; end_reason: string | null };
export type CarriedContext = { jobs: Carried[]; omitted: number };

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const entry = (db: Database.Database, jobId: string, key: string) =>
  (db.prepare("SELECT message_json FROM runtime_history WHERE job_id=? AND entry_key=?").get(jobId, key) as { message_json: string } | undefined)?.message_json;

/**
 * One finished job as a user message and an assistant reply. Tool calls stay
 * out: they may be unresolved, and their effects are in the workspace. A job
 * that did not succeed says so, after its answer if it gave one.
 */
function exchange(db: Database.Database, job: Carried) {
  const jobId = job.job_id;
  const user = JSON.parse(entry(db, jobId, `user:${jobId}`)!);
  const final = entry(db, jobId, `final:${jobId}`);
  const note = job.state === "succeeded" ? undefined
    : job.end_reason === "verification_failed" ? "[The verification command of this task failed.]"
    : `[This task did not finish: ${job.state}${job.end_reason ? ` (${job.end_reason})` : ""}.]`;
  if (final) {
    const answer = JSON.parse(final);
    if (note) answer.content = [...answer.content, { type: "text", text: note }];
    return [user, answer];
  }
  return [user, { role: "assistant", content: [{ type: "text", text: note }], api: "willcord", provider: "willcord", model: "none", usage: ZERO_USAGE, stopReason: "stop", timestamp: user.timestamp }];
}

/**
 * Inside the transaction that first writes the job's user message: fix the
 * earlier finished exchanges of its session it carries, the newest that fit
 * within `limit` characters. Jobs that never ran are skipped. Each job's
 * outcome is fixed with it, so the carried context never changes and a
 * rebuilt transcript is identical.
 */
export function freezeContext(db: Database.Database, jobId: string, limit = Number(process.env.SESSION_CONTEXT_CHARS ?? DEFAULT_SESSION_CONTEXT_CHARS)) {
  const earlier = db.prepare(`SELECT p.job_id,p.state,p.end_reason FROM jobs p JOIN jobs c ON c.job_id=?
    WHERE p.session_id=c.session_id AND p.state IN ('succeeded','failed','cancelled')
      AND (p.created_at<c.created_at OR (p.created_at=c.created_at AND p.rowid<c.rowid))
      AND EXISTS (SELECT 1 FROM runtime_history h WHERE h.job_id=p.job_id AND h.entry_key='user:'||p.job_id)
    ORDER BY p.created_at DESC,p.rowid DESC`).all(jobId) as Carried[];
  const kept: Carried[] = [];
  let used = 0;
  for (const job of earlier) {
    used += exchange(db, job).reduce((n, m) => n + JSON.stringify(m.content).length, 0);
    if (used > limit) break;
    kept.unshift(job);
  }
  const context: CarriedContext = { jobs: kept, omitted: earlier.length - kept.length };
  db.prepare("UPDATE jobs SET context_json=? WHERE job_id=?").run(JSON.stringify(context), jobId);
}

/** The carried exchanges, rendered from the fixed context; none for a job that has not run. */
export function priorContext(db: Database.Database, jobId: string) {
  const row = db.prepare("SELECT context_json FROM jobs WHERE job_id=?").get(jobId) as { context_json: string | null } | undefined;
  if (!row?.context_json) return { messages: [] as any[], omitted: 0 };
  const context = JSON.parse(row.context_json) as CarriedContext;
  return { messages: context.jobs.flatMap((job) => exchange(db, job)), omitted: context.omitted };
}

/** Said before the first message when older exchanges were left out. */
export function omittedNote(omitted: number) {
  return { type: "text", text: `[${omitted} earlier exchange${omitted === 1 ? "" : "s"} of this session ${omitted === 1 ? "is" : "are"} not included.]` };
}
