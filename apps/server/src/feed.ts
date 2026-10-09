import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { CarriedContext } from "./context.js";
import { mainSession } from "./jobs.js";

/** Model view of each stream: chunks past this point may be dropped when the node is full. */
const MODEL_STREAM_BYTES = 64 * 1024;
/** Events kept for replay: the newest RETAIN_EVENTS, and none older than RETAIN_MS. */
export const RETAIN_EVENTS = 100_000;
export const RETAIN_MS = 7 * 24 * 3600 * 1000;
const BATCH = 500;
const HEARTBEAT_MS = 15_000;

export type FeedEvent = { event_id: number; kind: string; entity_id: string; session_id: string | null; job_id: string | null; data: unknown };

const JOB_VIEW = `SELECT j.job_id,j.session_id,j.worker_id,j.client_request_id,j.input_text,j.state,j.queue_seq,j.created_at,j.started_at,j.wait_until,
  j.cancel_requested,j.cancel_reason,j.end_reason,j.max_tool_calls,j.max_tokens,j.max_runtime_secs,j.deadline_at,
  r.tool_calls_used,r.tokens_used,j.parent_job_id,j.delegation_id,j.result_json,j.verify_command,j.context_json,
  CASE WHEN j.state IN ('queued','waiting_worker') AND j.queue_seq IS NOT NULL THEN (SELECT COUNT(*) FROM jobs q WHERE q.worker_id=j.worker_id AND q.state IN ('queued','waiting_worker') AND q.queue_seq<=j.queue_seq) ELSE NULL END AS queue_position,
  (SELECT json_group_array(json_object('job_id',c.job_id,'session_id',c.session_id,'delegation_id',c.delegation_id,'worker_id',c.worker_id,
     'state',c.state,'end_reason',c.end_reason,'cancel_requested',c.cancel_requested,'result',json(c.result_json)))
   FROM (SELECT * FROM jobs WHERE parent_job_id=j.job_id ORDER BY created_at,rowid) c) AS children_json
  FROM jobs j LEFT JOIN budget_roots r ON r.root_job_id=j.root_job_id`;

const CHILD_FAILED = new Set(["failed", "cancelled"]);

/**
 * A job as the UI shows it: budget use, queue place, its delegated children
 * with their results, and how many earlier exchanges of its session it carries.
 */
function jobRow(row: any) {
  const { children_json, context_json, ...job } = row;
  const children = JSON.parse(children_json) as Array<{ state: string }>;
  const context = context_json ? JSON.parse(context_json) as CarriedContext : null;
  return {
    ...job, children,
    context: context && { jobs: context.jobs.length, omitted: context.omitted },
    children_summary: {
      total: children.length,
      succeeded: children.filter((c) => c.state === "succeeded").length,
      failed: children.filter((c) => CHILD_FAILED.has(c.state)).length,
      needs_attention: children.filter((c) => c.state === "needs_attention").length,
      open: children.filter((c) => !["succeeded", "failed", "cancelled", "needs_attention"].includes(c.state)).length,
    },
  };
}

export function jobView(db: Database.Database, jobId: string) {
  const row = db.prepare(`${JOB_VIEW} WHERE j.job_id=?`).get(jobId);
  return row ? jobRow(row) : null;
}

export function sessionJobs(db: Database.Database, sessionId: string) {
  return (db.prepare(`${JOB_VIEW} WHERE j.session_id=? ORDER BY j.created_at,j.rowid`).all(sessionId) as any[]).map(jobRow);
}

const WORKER_VIEW = `SELECT w.*,s.active_job_id,
  (SELECT COUNT(*) FROM jobs q WHERE q.worker_id=w.worker_id AND q.state IN ('queued','waiting_worker') AND q.queue_seq IS NOT NULL) queued_jobs
  FROM workers w LEFT JOIN worker_slots s USING(worker_id)`;

/** Connection and execution are separate: online alone never means it can run work. */
function workerRow(w: any) {
  return { ...w, schedulable: Boolean(w.online && w.reconciled && !w.blocked) };
}

export function workerViews(db: Database.Database) {
  return (db.prepare(`${WORKER_VIEW} ORDER BY w.worker_id`).all() as any[]).map(workerRow);
}

function workerView(db: Database.Database, workerId: string) {
  const row = db.prepare(`${WORKER_VIEW} WHERE w.worker_id=?`).get(workerId);
  return row ? workerRow(row) : null;
}

const CALL_VIEW = "SELECT job_id,call_id,call_seq,tool_name,CASE WHEN tool_name='write' THEN json_set(json_remove(arguments_json,'$.content'),'$.content_bytes',length(CAST(json_extract(arguments_json,'$.content') AS BLOB))) ELSE arguments_json END arguments_json,status,completed_at,cancel_sent_at,resolve_acked FROM runtime_calls";

/** A call's request and status. Its result reaches the UI as the tool message. */
function callRow({ arguments_json, ...row }: any) {
  // Written file content (up to 1 MiB) is replaced by its size in CALL_VIEW.
  return { ...row, arguments: JSON.parse(arguments_json) };
}

/**
 * What is stored of one stream: counts, flags and every gap. A gap is a range
 * of chunks the worker logged that this node does not hold. Chunks dropped
 * because this node was full are truncation, reported by main_truncated.
 */
export function logView(db: Database.Database, jobId: string, callId: string, stream: string) {
  const state = db.prepare("SELECT job_id,call_id,stream,chunks,bytes_total,worker_truncated,main_truncated,state FROM call_log_state WHERE job_id=? AND call_id=? AND stream=?").get(jobId, callId, stream) as any;
  if (!state) return null;
  const held = db.prepare("SELECT seq,offset,length(data) n FROM call_logs WHERE job_id=? AND call_id=? AND stream=? ORDER BY seq").all(jobId, callId, stream) as Array<{ seq: number; offset: number; n: number }>;
  const gaps: Array<{ from_seq: number; to_seq: number | null; from_offset: number; missing_bytes: number | null }> = [];
  let seq = 0, offset = 0, bytes = 0;
  for (const c of held) {
    if (c.seq !== seq && !(state.main_truncated && offset >= MODEL_STREAM_BYTES))
      gaps.push({ from_seq: seq, to_seq: c.seq - 1, from_offset: offset, missing_bytes: c.offset - offset });
    seq = c.seq + 1; offset = c.offset + c.n; bytes += c.n;
  }
  // The tail is a gap only once nothing more can arrive and nothing explains it.
  if (state.chunks !== null && seq < state.chunks && state.state !== "streaming" && !(state.main_truncated && offset >= MODEL_STREAM_BYTES))
    gaps.push({ from_seq: seq, to_seq: state.chunks - 1, from_offset: offset, missing_bytes: state.bytes_total === null || state.worker_truncated ? null : Math.max(0, state.bytes_total - offset) });
  return { ...state, chunks_held: held.length, bytes_held: bytes, gaps };
}

function logViews(db: Database.Database, sessionId: string) {
  const rows = db.prepare("SELECT s.job_id,s.call_id,s.stream FROM call_log_state s JOIN jobs j USING(job_id) WHERE j.session_id=?").all(sessionId) as Array<{ job_id: string; call_id: string; stream: string }>;
  return rows.map((r) => logView(db, r.job_id, r.call_id, r.stream));
}

/** The current state of an event's entity; null when it no longer exists. */
function materialize(db: Database.Database, e: { kind: string; entity_id: string; job_id: string | null }): unknown {
  switch (e.kind) {
    case "job": return jobView(db, e.entity_id);
    case "worker": return workerView(db, e.entity_id);
    case "session": return db.prepare("SELECT * FROM sessions WHERE session_id=?").get(e.entity_id) ?? null;
    case "message": return db.prepare("SELECT * FROM messages WHERE message_id=?").get(e.entity_id) ?? null;
    case "call": { const row = db.prepare(`${CALL_VIEW} WHERE job_id=? AND call_id=?`).get(e.job_id, e.entity_id); return row ? callRow(row) : null; }
    case "log": { const slash = e.entity_id.lastIndexOf("/"); return logView(db, e.job_id!, e.entity_id.slice(0, slash), e.entity_id.slice(slash + 1)); }
    case "draft": return db.prepare("SELECT * FROM model_drafts WHERE draft_id=?").get(e.entity_id) ?? null;
    case "attention": return db.prepare("SELECT action_id,worker_id,job_id,action,created_at FROM attention_actions WHERE action_id=?").get(e.entity_id) ?? null;
    default: return null;
  }
}

export function cursorNow(db: Database.Database) {
  // Retention may have removed every row; the floor still marks where the feed is.
  return (db.prepare("SELECT MAX(COALESCE((SELECT MAX(event_id) FROM events),0),(SELECT floor FROM event_floor WHERE id=1)) n").get() as { n: number }).n;
}

function floor(db: Database.Database) {
  return (db.prepare("SELECT floor FROM event_floor WHERE id=1").get() as { floor: number }).floor;
}

/**
 * Events after a cursor, coalesced: an entity that changed several times is
 * sent once, at its latest event, with its current state.
 */
export function eventsAfter(db: Database.Database, after: number, limit = BATCH): { events: FeedEvent[]; through: number } {
  const rows = db.prepare("SELECT event_id,kind,entity_id,session_id,job_id FROM events WHERE event_id>? ORDER BY event_id LIMIT ?").all(after, limit) as Array<Omit<FeedEvent, "data">>;
  const through = rows.length ? rows[rows.length - 1].event_id : after;
  const latest = new Map<string, Omit<FeedEvent, "data">>();
  for (const row of rows) if (row.kind) { const k = `${row.kind}\u0000${row.job_id ?? ""}\u0000${row.entity_id}`; latest.delete(k); latest.set(k, row); }
  return { events: [...latest.values()].map((e) => ({ ...e, data: materialize(db, e) })), through };
}

/**
 * One consistent read: the cursor and every view the UI starts from. A selected
 * session adds its transcript, jobs, calls, logs and unfinished drafts.
 */
export function snapshot(db: Database.Database, now: () => number, sessionId?: string) {
  const main = mainSession(db, now);
  return db.transaction(() => {
    const session = sessionId ? db.prepare("SELECT * FROM sessions WHERE session_id=?").get(sessionId) : undefined;
    if (sessionId && !session) return undefined;
    return {
      cursor: cursorNow(db),
      main_session_id: (main as any).session_id as string,
      workers: workerViews(db),
      sessions: db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all(),
      session: session ? {
        session,
        messages: db.prepare("SELECT * FROM messages WHERE session_id=? ORDER BY seq").all(sessionId),
        jobs: sessionJobs(db, sessionId!),
        calls: (db.prepare(`${CALL_VIEW} WHERE job_id IN (SELECT job_id FROM jobs WHERE session_id=?) ORDER BY call_seq`).all(sessionId) as any[]).map(callRow),
        logs: logViews(db, sessionId!),
        drafts: db.prepare("SELECT * FROM model_drafts WHERE session_id=? AND state<>'committed' ORDER BY created_at").all(sessionId),
      } : null,
    };
  })();
}

/** Drop old events. A cursor at or below the new floor has to start over from a snapshot. */
export function pruneEvents(db: Database.Database, now: () => number, keep = RETAIN_EVENTS, maxAgeMs = RETAIN_MS) {
  db.transaction(() => {
    const max = cursorNow(db);
    const byCount = max - keep;
    const byAge = (db.prepare("SELECT COALESCE(MAX(event_id),0) n FROM events WHERE created_at<?").get(now() - maxAgeMs) as { n: number }).n;
    const cut = Math.max(byCount, byAge);
    if (cut <= floor(db)) return;
    // Audit rows (no kind) are not part of the feed and stay.
    db.prepare("DELETE FROM events WHERE event_id<=? AND kind IS NOT NULL").run(cut);
    db.prepare("UPDATE event_floor SET floor=? WHERE id=1").run(cut);
  })();
}

/**
 * Snapshot and SSE routes. Live delivery polls the event table, so every
 * committed change reaches subscribers, whichever code path made it.
 */
export function registerFeed(app: FastifyInstance, db: Database.Database, now: () => number, authenticated: (token: string | undefined) => boolean, options: { pollMs?: number; pruneMs?: number; keep?: number; maxAgeMs?: number } = {}) {
  /** A stream lives only as long as the login that opened it. */
  type Client = { after: number; token: string | undefined; write(chunk: string): void; end(): void };
  const clients = new Set<Client>();
  const send = (client: Client) => {
    for (;;) {
      const { events, through } = eventsAfter(db, client.after);
      if (through === client.after) return;
      let out = "";
      for (const e of events) out += `id: ${e.event_id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
      // The id line after a coalesced batch moves the browser's Last-Event-ID past skipped rows.
      if (!events.length || events[events.length - 1].event_id !== through) out += `id: ${through}\nevent: cursor\ndata: {"cursor":${through}}\n\n`;
      client.write(out);
      client.after = through;
    }
  };
  let lastSeen = cursorNow(db);
  const poll = setInterval(() => {
    if (!clients.size) return;
    for (const c of clients) if (!authenticated(c.token)) { c.end(); clients.delete(c); }
    const max = cursorNow(db);
    if (max === lastSeen) return;
    lastSeen = max;
    for (const c of clients) {
      try { if (!authenticated(c.token)) throw new Error("logged_out"); send(c); } catch { c.end(); clients.delete(c); }
    }
  }, options.pollMs ?? 100);
  poll.unref();
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (authenticated(c.token)) c.write(": ping\n\n");
      else { c.end(); clients.delete(c); }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const prune = () => pruneEvents(db, now, options.keep, options.maxAgeMs);
  prune();
  const pruneTimer = setInterval(prune, options.pruneMs ?? 3600_000);
  pruneTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(poll); clearInterval(heartbeat); clearInterval(pruneTimer);
    for (const c of clients) c.end();
    clients.clear();
  });

  app.get<{ Querystring: { session_id?: string } }>("/api/snapshot", async (req, reply) =>
    snapshot(db, now, req.query.session_id) ?? reply.code(404).send({ error: "session_not_found" }));

  app.get<{ Querystring: { after?: string } }>("/api/events", async (req, reply) => {
    const header = req.headers["last-event-id"];
    const raw = typeof header === "string" && header ? header : req.query.after;
    const after = Number(raw);
    if (raw === undefined || !Number.isSafeInteger(after) || after < 0) return reply.code(400).send({ error: "cursor_required" });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    // An expired cursor, or one this database never issued, cannot be replayed.
    if (after < floor(db) || after > cursorNow(db)) {
      res.end(`event: reset\ndata: {"reason":"cursor_expired"}\n\n`);
      return;
    }
    res.write("retry: 2000\n\n");
    const client: Client = { after, token: req.cookies.session, write: (chunk) => res.write(chunk), end: () => res.end() };
    send(client);
    clients.add(client);
    req.raw.on("close", () => clients.delete(client));
  });
}
