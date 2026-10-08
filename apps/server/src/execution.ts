import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { WorkerFrame } from "@worker-plane/protocol";
import { requestHash } from "@worker-plane/protocol";
import { mainFault } from "./fault.js";

type Socket = { readyState: number; send(data: string): void };
type Connection = { epoch: number; socket: Socket; tokenDigest: string };
export type ToolRecord = { ok: boolean; result: any };
type Pending = { workerId: string; jobId: string; callId: string; promise: Promise<ToolRecord>; resolve(record: ToolRecord): void; reject(error: Error): void; timer: NodeJS.Timeout };
type CallRow = { job_id: string; turn_key: string; call_id: string; call_seq: number; request_hash: string; tool_name: string; arguments_json: string; status: string; result_json: string | null; completed_at: number | null; worker_id: string; workspace_id: string; workspace_version: number };
type CallReport = { job_id: string; call_id: string; call_seq: number; request_hash: string; status: string; boot_id: string };
/** Scripted model turns for isolated acceptance; never a real provider. */
export type ScriptStep = { tool: "read" | "write" | "bash"; arguments: Record<string, unknown>; id?: string } | { text: string };

const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const TOOL_RESULT_TIMEOUT_MS = 1_800_000;
/** Beyond a bash time limit: the worker's TERM grace (at most 30 s) and stop confirmation. */
const STOP_MARGIN_MS = 60_000;
/** Output of one stream the model sees; the rest stays in the call log. */
export const MODEL_STREAM_BYTES = 64 * 1024;
const LOG_CHUNK_BYTES = 16 * 1024;
const DEFAULT_LOG_CAPACITY_BYTES = 1024 ** 3;
const STREAMS = ["stdout", "stderr"] as const;
type Stream = (typeof STREAMS)[number];
type LogSummary = Record<Stream, { bytes_total: number; bytes_logged: number; chunks: number }> & { truncated: boolean };
type ResultFrame = Extract<WorkerFrame, { type: "tool_result" }>;
const MAX_MODEL_TURNS = 20;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const key = (jobId: string, callId: string) => `${jobId}\u0000${callId}`;

/** A bash result whose output the worker stored as chunks. */
const loggedOutput = (result: any): LogSummary | undefined =>
  result && typeof result === "object" && result.logs && typeof result.logs.stdout?.chunks === "number" && typeof result.logs.stderr?.chunks === "number" ? result.logs : undefined;

/** The worker's own record, without the output this node assembled from chunks. */
const workerRecord = (record: ToolRecord): ToolRecord => {
  if (!record.result || typeof record.result !== "object" || !("output" in record.result)) return record;
  const { output: _output, ...result } = record.result;
  return { ok: record.ok, result };
};

/** Pi-visible output of a worker result. Live execution and SQLite recovery must agree. */
export function toolOutput(record: ToolRecord) {
  return { content: [{ type: "text" as const, text: JSON.stringify(record.result) }], details: record.result, isError: !record.ok };
}

export class ExecutionCoordinator {
  readonly pending = new Map<string, Pending>();
  private readonly inFlight = new Set<string>();
  private readonly running = new Set<string>();
  private closed = false;
  constructor(
    readonly db: Database.Database,
    readonly connections: Map<string, Connection>,
    readonly now = Date.now,
    readonly runJob?: (job: any) => Promise<void>,
    readonly options: { dataDir?: string; fakeScript?: (job: any) => ScriptStep[]; toolResultTimeoutMs?: number; logCapacityBytes?: number } = {},
  ) {}

  /** Results that wait for the head of their output before they commit. */
  private readonly held = new Map<string, ResultFrame>();
  /** One log_fetch in flight per stream, keyed job/call/stream, valued by worker. */
  private readonly fetching = new Map<string, string>();
  private storedLogBytes?: number;

  close() {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("coordinator_closed")); }
    this.pending.clear();
  }

  private call(jobId: string, callId: string) {
    return this.db.prepare(`SELECT c.*,j.worker_id,s.workspace_id,s.workspace_version FROM runtime_calls c JOIN jobs j USING(job_id) JOIN sessions s USING(session_id) WHERE c.job_id=? AND c.call_id=?`).get(jobId, callId) as CallRow | undefined;
  }

  /** A connection may carry calls only after this epoch reconciled and while the worker is unblocked. */
  private connection(workerId: string) {
    const conn = this.connections.get(workerId);
    const worker = this.db.prepare("SELECT connection_epoch,reconciled,blocked FROM workers WHERE worker_id=?").get(workerId) as { connection_epoch: number; reconciled: number; blocked: number } | undefined;
    if (!conn || conn.socket.readyState !== 1 || !worker || worker.connection_epoch !== conn.epoch || !worker.reconciled || worker.blocked) return undefined;
    return conn;
  }

  private attention(workerId: string, jobId: string | null, reason: string, evidence: unknown) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE workers SET blocked=1 WHERE worker_id=?").run(workerId);
      if (jobId) this.db.prepare("UPDATE jobs SET state='needs_attention' WHERE job_id=? AND state NOT IN ('succeeded','failed','cancelled')").run(jobId);
      const job = jobId && this.db.prepare("SELECT 1 FROM jobs WHERE job_id=?").get(jobId) ? jobId : null;
      this.db.prepare("INSERT INTO attention_actions(action_id,worker_id,job_id,action,evidence,created_at) VALUES(?,?,?,'blocked',?,?)").run(randomUUID(), workerId, job, JSON.stringify({ reason, evidence }), this.now());
    })();
  }

  /** Execution can no longer be proven either way: never retry it, block the worker. */
  private markUnknown(row: CallRow, reason: string, evidence: unknown) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE runtime_calls SET status='unknown' WHERE job_id=? AND call_id=? AND status<>'completed'").run(row.job_id, row.call_id);
      this.db.prepare("UPDATE tool_calls SET state='unknown' WHERE call_id=? AND state<>'finished'").run(row.call_id);
      this.attention(row.worker_id, row.job_id, reason, evidence);
    })();
    const p = this.pending.get(key(row.job_id, row.call_id));
    if (p) { clearTimeout(p.timer); this.pending.delete(key(row.job_id, row.call_id)); p.reject(new Error(reason)); }
  }

  private sendCall(conn: Connection, row: CallRow) {
    const args = JSON.parse(row.arguments_json);
    const request = { worker_id: row.worker_id, job_id: row.job_id, call_id: row.call_id, call_seq: row.call_seq, workspace_id: row.workspace_id, config_version: row.workspace_version, tool: row.tool_name, arguments: args };
    const digest = requestHash(request);
    if (digest !== row.request_hash) throw new Error("committed_request_hash_mismatch");
    const base = { protocol_version: 1, worker_id: row.worker_id, connection_epoch: conn.epoch, job_id: row.job_id, call_id: row.call_id, request_hash: digest };
    if (row.tool_name !== "write") {
      conn.socket.send(JSON.stringify({ ...base, type: "tool_call", call_seq: row.call_seq, workspace_id: row.workspace_id, config_version: row.workspace_version, tool: row.tool_name, arguments: args }));
      return;
    }
    const bytes = Buffer.from(args.content, "utf8");
    const chunks = Math.max(1, Math.ceil(bytes.length / 24000));
    const { content: _content, ...rest } = args;
    conn.socket.send(JSON.stringify({ ...base, type: "tool_call", call_seq: row.call_seq, workspace_id: row.workspace_id, config_version: row.workspace_version, tool: row.tool_name, arguments: { ...rest, transfer_bytes: bytes.length, transfer_sha256: createHash("sha256").update(bytes).digest("hex"), transfer_chunks: chunks } }));
    for (let index = 0; index < chunks; index++) {
      const chunk = bytes.subarray(index * 24000, Math.min(bytes.length, (index + 1) * 24000));
      conn.socket.send(JSON.stringify({ ...base, type: "tool_data", chunk_index: index, data: chunk.toString("base64"), final: index === chunks - 1 }));
    }
  }

  private deliver(p: Pending) {
    const conn = this.connection(p.workerId);
    const row = this.call(p.jobId, p.callId);
    if (!conn || row?.status !== "dispatched") return;
    // A request that no longer rebuilds from its commit is a local
    // contradiction, not a protocol error: block, keep the connection.
    try { this.sendCall(conn, row); } catch (error) { this.markUnknown(row, "committed_request_unrebuildable", { call_id: row.call_id, error: String(error) }); }
  }

  /**
   * Run one committed intent. The result is authoritative only once committed;
   * while the worker is away the call keeps waiting and is re-sent unchanged.
   */
  dispatch(jobId: string, callId: string): Promise<ToolRecord> {
    const existing = this.pending.get(key(jobId, callId));
    if (existing) return existing.promise;
    const row = this.call(jobId, callId);
    if (!row) return Promise.reject(new Error("tool_intent_not_committed"));
    if (row.status === "completed") return Promise.resolve(JSON.parse(row.result_json!));
    if (row.status === "unknown") return Promise.reject(new Error("call_unknown"));
    if (typeof JSON.parse(row.arguments_json).content !== "string" && row.tool_name === "write") return Promise.reject(new Error("write_content_required"));
    if (row.tool_name === "write" && Buffer.byteLength(JSON.parse(row.arguments_json).content) > 1024 * 1024) return Promise.reject(new Error("write_exceeds_1_mib"));
    this.db.transaction(() => {
      this.db.prepare("UPDATE runtime_calls SET status='dispatched' WHERE job_id=? AND call_id=? AND status='committed'").run(jobId, callId);
      this.db.prepare("INSERT OR IGNORE INTO tool_calls(call_id,job_id,call_seq,request_hash,request_json,state) VALUES(?,?,?,?,?,'running')").run(callId, jobId, row.call_seq, row.request_hash, row.arguments_json);
    })();
    let settle!: Pick<Pending, "resolve" | "reject">;
    const promise = new Promise<ToolRecord>((resolve, reject) => (settle = { resolve, reject }));
    const timer = setTimeout(() => { const current = this.call(jobId, callId); if (current) this.markUnknown(current, "tool_result_timeout", { call_id: callId }); }, this.options.toolResultTimeoutMs ?? resultTimeoutMs(row));
    timer.unref();
    const p: Pending = { workerId: row.worker_id, jobId, callId, promise, timer, ...settle };
    this.pending.set(key(jobId, callId), p);
    this.deliver(p);
    return promise;
  }

  private ack(row: CallRow) {
    const conn = this.connection(row.worker_id);
    conn?.socket.send(JSON.stringify({ protocol_version: 1, type: "tool_ack", worker_id: row.worker_id, connection_epoch: conn.epoch, job_id: row.job_id, call_id: row.call_id, request_hash: row.request_hash, ack_through: row.call_seq }));
  }

  receive(frame: WorkerFrame) {
    if (frame.type === "tool_log") return this.receiveLog(frame);
    if (frame.type === "log_status") return this.receiveLogStatus(frame);
    if (frame.type !== "tool_result" && frame.type !== "tool_rejected") return;
    const row = this.call(frame.job_id, frame.call_id);
    if (!row || row.worker_id !== frame.worker_id || row.request_hash !== frame.request_hash) {
      this.attention(frame.worker_id, row ? row.job_id : null, "frame_for_unknown_call", frame);
      return;
    }
    if (frame.type === "tool_rejected") {
      if (row.status !== "completed") this.markUnknown(row, `tool_rejected:${frame.reason}`, frame);
      return;
    }
    const record: ToolRecord = { ok: frame.ok, result: frame.result };
    if (row.status === "completed") {
      if (isDeepStrictEqual(workerRecord(JSON.parse(row.result_json!)), record)) this.ack(row);
      else this.attention(row.worker_id, row.job_id, "result_contradiction", frame);
      return;
    }
    if (row.status !== "dispatched") {
      this.attention(row.worker_id, row.job_id, `result_for_${row.status}_call`, frame);
      return;
    }
    this.commitResult(row, frame);
  }

  /**
   * Commit a result once the head of its output is here. The model sees the
   * same assembled text live and after recovery, because it is committed.
   */
  private commitResult(row: CallRow, frame: ResultFrame) {
    const logs = loggedOutput(frame.result);
    const k = key(row.job_id, row.call_id);
    if (logs) {
      this.recordLogSummary(row, logs);
      let missing = false;
      for (const stream of STREAMS) {
        const from = this.headMissing(row, stream, logs);
        if (from === undefined) continue;
        missing = true;
        this.fetchLog(row, stream, from);
      }
      if (missing) { this.held.set(k, frame); return; }
    }
    this.held.delete(k);
    const record: ToolRecord = logs ? { ok: frame.ok, result: { ...frame.result, output: this.assemble(row, logs) } } : { ok: frame.ok, result: frame.result };
    this.db.transaction(() => {
      this.db.prepare("UPDATE runtime_calls SET status='completed',result_json=?,completed_at=? WHERE job_id=? AND call_id=? AND status='dispatched'").run(JSON.stringify(record), this.now(), row.job_id, row.call_id);
      this.db.prepare("UPDATE tool_calls SET state='finished',result_json=? WHERE call_id=?").run(JSON.stringify(record), row.call_id);
      this.db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,j.session_id,j.job_id,(SELECT COALESCE(MAX(seq),0)+1 FROM messages WHERE session_id=j.session_id),? FROM jobs j WHERE j.job_id=?").run(randomUUID(), JSON.stringify({ role: "tool", call_id: row.call_id, tool: row.tool_name, arguments: JSON.parse(row.arguments_json), content: record.result, ok: record.ok }), row.job_id);
    })();
    mainFault("after_result_commit");
    this.ack(row);
    if (logs) this.fetchRest(row);
    const p = this.pending.get(k);
    if (p) { clearTimeout(p.timer); this.pending.delete(k); p.resolve(record); }
  }

  private logBytes() {
    this.storedLogBytes ??= (this.db.prepare("SELECT COALESCE(SUM(length(data)),0) n FROM call_logs").get() as { n: number }).n;
    return this.storedLogBytes;
  }

  /** Store a chunk. Output beyond the model's view is dropped, visibly, once this node is full. */
  private receiveLog(frame: Extract<WorkerFrame, { type: "tool_log" }>) {
    const row = this.call(frame.job_id, frame.call_id);
    // Output is evidence, never authority: a chunk nobody asked for is ignored.
    if (!row || row.worker_id !== frame.worker_id || row.tool_name !== "bash") return;
    const data = Buffer.from(frame.data, "base64");
    if (data.length > LOG_CHUNK_BYTES) return;
    this.db.prepare("INSERT OR IGNORE INTO call_log_state(job_id,call_id,stream,state) VALUES(?,?,?,'streaming')").run(row.job_id, row.call_id, frame.stream);
    if (frame.offset >= MODEL_STREAM_BYTES && this.logBytes() + data.length > (this.options.logCapacityBytes ?? DEFAULT_LOG_CAPACITY_BYTES)) {
      this.db.prepare("UPDATE call_log_state SET main_truncated=1 WHERE job_id=? AND call_id=? AND stream=?").run(row.job_id, row.call_id, frame.stream);
      return;
    }
    const inserted = this.db.prepare("INSERT OR IGNORE INTO call_logs VALUES(?,?,?,?,?,?)").run(row.job_id, row.call_id, frame.stream, frame.seq, frame.offset, data).changes;
    if (inserted) this.storedLogBytes = this.logBytes() + data.length;
    this.retryHeld(row);
  }

  private receiveLogStatus(frame: Extract<WorkerFrame, { type: "log_status" }>) {
    const row = this.call(frame.job_id, frame.call_id);
    if (!row || row.worker_id !== frame.worker_id || row.tool_name !== "bash") return;
    if (frame.state === "expired") {
      this.fetching.delete(`${key(row.job_id, row.call_id)}\u0000${frame.stream}`);
      // The worker no longer has it: whatever is missing stays a visible gap.
      this.db.prepare("UPDATE call_log_state SET state='expired' WHERE job_id=? AND call_id=? AND stream=? AND state<>'complete'").run(row.job_id, row.call_id, frame.stream);
      this.retryHeld(row);
      return;
    }
    this.fetching.delete(`${key(row.job_id, row.call_id)}\u0000${frame.stream}`);
    if (frame.state === "running") return;
    this.retryHeld(row);
    if (this.call(row.job_id, row.call_id)?.status === "completed") this.fetchRest(row, [frame.stream]);
  }

  private retryHeld(row: CallRow) {
    const frame = this.held.get(key(row.job_id, row.call_id));
    const current = frame && this.call(row.job_id, row.call_id);
    if (current?.status === "dispatched") this.commitResult(current, frame!);
  }

  private recordLogSummary(row: CallRow, logs: LogSummary) {
    for (const stream of STREAMS)
      this.db.prepare(`INSERT INTO call_log_state(job_id,call_id,stream,chunks,bytes_total,worker_truncated,state) VALUES(?,?,?,?,?,?,'streaming')
        ON CONFLICT(job_id,call_id,stream) DO UPDATE SET chunks=excluded.chunks,bytes_total=excluded.bytes_total,worker_truncated=excluded.worker_truncated`)
        .run(row.job_id, row.call_id, stream, logs[stream].chunks, logs[stream].bytes_total, Number(logs.truncated));
  }

  private chunks(row: CallRow, stream: Stream) {
    return this.db.prepare("SELECT seq,offset,data FROM call_logs WHERE job_id=? AND call_id=? AND stream=? ORDER BY seq").all(row.job_id, row.call_id, stream) as Array<{ seq: number; offset: number; data: Buffer }>;
  }

  /** First chunk the model's view still lacks, or undefined when the head is complete or gone for good. */
  private headMissing(row: CallRow, stream: Stream, logs: LogSummary) {
    const state = this.db.prepare("SELECT state FROM call_log_state WHERE job_id=? AND call_id=? AND stream=?").get(row.job_id, row.call_id, stream) as { state: string } | undefined;
    if (state?.state === "expired") return undefined;
    const need = Math.min(MODEL_STREAM_BYTES, logs[stream].bytes_logged);
    let next = 0, covered = 0;
    for (const chunk of this.chunks(row, stream)) {
      if (covered >= need) break;
      if (chunk.seq !== next || chunk.offset !== covered) return next;
      covered += chunk.data.length; next++;
    }
    return covered >= need || next >= logs[stream].chunks ? undefined : next;
  }

  /** The model's view: the first 64 KiB of each stream, with what was left out stated. */
  private assemble(row: CallRow, logs: LogSummary) {
    const output: Record<string, unknown> = {};
    for (const stream of STREAMS) {
      const parts: Buffer[] = [];
      let covered = 0;
      for (const chunk of this.chunks(row, stream)) {
        if (chunk.offset !== covered || covered >= MODEL_STREAM_BYTES) break;
        parts.push(chunk.data); covered += chunk.data.length;
      }
      const shown = Buffer.concat(parts).subarray(0, MODEL_STREAM_BYTES);
      const total = logs[stream].bytes_total;
      output[stream] = { text: shown.toString("utf8"), bytes_shown: shown.length, bytes_total: total, truncated: shown.length < total, gap: shown.length < Math.min(MODEL_STREAM_BYTES, logs[stream].bytes_logged) };
    }
    return output;
  }

  private fetchLog(row: CallRow, stream: Stream, fromSeq: number) {
    const conn = this.connection(row.worker_id);
    const k = `${key(row.job_id, row.call_id)}\u0000${stream}`;
    if (!conn || this.fetching.has(k)) return;
    this.fetching.set(k, row.worker_id);
    conn.socket.send(JSON.stringify({ protocol_version: 1, type: "log_fetch", worker_id: row.worker_id, connection_epoch: conn.epoch, job_id: row.job_id, call_id: row.call_id, request_hash: row.request_hash, stream, from_seq: fromSeq }));
  }

  /**
   * Complete the stored log of a committed call, then release it on the worker.
   * Acknowledging is separate from the result ACK, so the worker keeps output
   * until this node holds it or has decided, visibly, not to keep it.
   */
  private fetchRest(row: CallRow, streams: readonly Stream[] = STREAMS) {
    for (const stream of streams) {
      const state = this.db.prepare("SELECT chunks,state,main_truncated FROM call_log_state WHERE job_id=? AND call_id=? AND stream=?").get(row.job_id, row.call_id, stream) as { chunks: number | null; state: string; main_truncated: number } | undefined;
      if (!state || state.chunks === null || state.state !== "streaming") continue;
      const held = this.chunks(row, stream).map((c) => c.seq);
      let next = 0;
      for (const seq of held) { if (seq !== next) break; next++; }
      if (next >= state.chunks || state.main_truncated) {
        this.db.prepare("UPDATE call_log_state SET state='complete' WHERE job_id=? AND call_id=? AND stream=?").run(row.job_id, row.call_id, stream);
        const conn = this.connection(row.worker_id);
        conn?.socket.send(JSON.stringify({ protocol_version: 1, type: "log_ack", worker_id: row.worker_id, connection_epoch: conn.epoch, job_id: row.job_id, call_id: row.call_id, request_hash: row.request_hash, stream, chunks: state.chunks }));
      } else this.fetchLog(row, stream, next);
    }
  }

  /** Stored output of a call for the operator, in pages of chunks. */
  readLog(jobId: string, callId: string, stream: Stream, fromSeq: number, limit = 64) {
    const state = this.db.prepare("SELECT chunks,bytes_total,worker_truncated,main_truncated,state FROM call_log_state WHERE job_id=? AND call_id=? AND stream=?").get(jobId, callId, stream);
    if (!state) return undefined;
    const chunks = (this.db.prepare("SELECT seq,offset,data FROM call_logs WHERE job_id=? AND call_id=? AND stream=? AND seq>=? ORDER BY seq LIMIT ?").all(jobId, callId, stream, fromSeq, limit) as Array<{ seq: number; offset: number; data: Buffer }>)
      .map((c) => ({ seq: c.seq, offset: c.offset, data: c.data.toString("base64") }));
    return { ...state, items: chunks };
  }

  /**
   * Compare the worker ledger with committed intents. Anything that cannot be
   * explained blocks the worker; nothing here starts execution.
   */
  reconcile(workerId: string, report: CallReport[]) {
    const worker = this.db.prepare("SELECT boot_id FROM workers WHERE worker_id=?").get(workerId) as { boot_id: string };
    const reacks: CallRow[] = [];
    for (const entry of report) {
      const row = this.call(entry.job_id, entry.call_id);
      const matches = row && row.worker_id === workerId && row.request_hash === entry.request_hash && row.call_seq === entry.call_seq;
      if (entry.status === "unknown" || entry.call_seq === 0) {
        if (matches && row.status !== "completed") this.markUnknown(row, "worker_reports_unknown_execution", entry);
        else this.attention(workerId, matches ? row.job_id : null, "worker_reports_unknown_execution", entry);
      } else if (!matches) {
        this.attention(workerId, row ? row.job_id : null, "ledger_contradiction", entry);
      } else if (row.status === "unknown" || row.status === "committed") {
        this.attention(workerId, row.job_id, `ledger_reports_${row.status}_call`, entry);
      } else if (entry.status === "completed") {
        if (row.status === "completed") reacks.push(row);
      } else if (row.status === "completed" || entry.boot_id !== worker.boot_id) {
        this.attention(workerId, row.job_id, "in_flight_contradiction", entry);
      }
    }
    const slot = this.db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id=?").get(workerId) as { active_job_id: string | null } | undefined;
    if (slot?.active_job_id && !this.db.prepare("SELECT 1 FROM jobs WHERE job_id=? AND worker_id=?").get(slot.active_job_id, workerId))
      this.attention(workerId, null, "slot_held_by_unknown_job", { active_job_id: slot.active_job_id });
    return reacks;
  }

  /** After the worker is ready: repeat lost ACKs, re-send waiting calls, resume the queue. */
  resumeWorker(workerId: string, reacks: CallRow[] = []) {
    for (const row of reacks) this.ack(row);
    // Fetches sent on an earlier connection will never be answered.
    for (const [k, owner] of this.fetching) if (owner === workerId) this.fetching.delete(k);
    // Output still being completed when the connection went away.
    const incomplete = this.db.prepare("SELECT DISTINCT s.job_id,s.call_id FROM call_log_state s JOIN jobs j USING(job_id) WHERE j.worker_id=? AND s.state='streaming'").all(workerId) as Array<{ job_id: string; call_id: string }>;
    for (const { job_id, call_id } of incomplete) {
      const row = this.call(job_id, call_id);
      if (row?.status === "completed") this.fetchRest(row);
    }
    for (const p of this.pending.values()) if (p.workerId === workerId) this.deliver(p);
    void this.pump(workerId);
  }

  async pump(workerId: string) {
    if (this.inFlight.has(workerId) || this.closed) return;
    this.inFlight.add(workerId);
    try {
      while (!this.closed) {
        const worker = this.db.prepare("SELECT online,reconciled,blocked FROM workers WHERE worker_id=?").get(workerId) as any;
        if (!worker || !worker.online || !worker.reconciled || worker.blocked) return;
        const slot = (this.db.prepare("SELECT active_job_id FROM worker_slots WHERE worker_id=?").get(workerId) as any)?.active_job_id as string | null;
        if (slot) {
          if (this.running.has(slot)) return;
          const active = this.db.prepare("SELECT state FROM jobs WHERE job_id=? AND worker_id=?").get(slot, workerId) as { state: string } | undefined;
          if (!active) return;
          if (active.state === "running") { await this.execute(slot); continue; }
          if (!this.release(workerId, slot)) return;
          continue;
        }
        const job = this.db.prepare("SELECT job_id,session_id,wait_until FROM jobs WHERE worker_id=? AND state IN ('queued','waiting_worker') ORDER BY queue_seq LIMIT 1").get(workerId) as any;
        if (!job) return;
        if (job.wait_until && job.wait_until < this.now()) { this.db.prepare("UPDATE jobs SET state='failed' WHERE job_id=?").run(job.job_id); continue; }
        if (!workspaceCurrent(this.db, job.session_id)) { this.failStaleWorkspace(job.job_id, job.session_id); continue; }
        const claimed = this.db.transaction(() => {
          if (this.db.prepare("UPDATE worker_slots SET active_job_id=? WHERE worker_id=? AND active_job_id IS NULL").run(job.job_id, workerId).changes !== 1) return false;
          this.db.prepare("UPDATE jobs SET state='running',started_at=? WHERE job_id=?").run(this.now(), job.job_id);
          return true;
        })();
        if (claimed) await this.execute(job.job_id);
      }
    } finally { this.inFlight.delete(workerId); }
  }

  /** Queued work never moves to a workspace its session did not bind. */
  private failStaleWorkspace(jobId: string, sessionId: string) {
    this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET state='failed' WHERE job_id=? AND state IN ('queued','waiting_worker')").run(jobId);
      this.db.prepare("INSERT INTO events(created_at,content_json) VALUES(?,?)").run(this.now(), JSON.stringify({ type: "job_failed", job_id: jobId, session_id: sessionId, reason: "workspace_version_changed" }));
    })();
  }

  /** Release only when no call of the job can still be executing. */
  private release(workerId: string, jobId: string) {
    const job = this.db.prepare("SELECT state FROM jobs WHERE job_id=?").get(jobId) as { state: string };
    const unresolved = this.db.prepare("SELECT 1 FROM runtime_calls WHERE job_id=? AND status IN ('dispatched','unknown')").get(jobId);
    if (!TERMINAL.has(job.state) || unresolved) return false;
    this.db.prepare("UPDATE worker_slots SET active_job_id=NULL WHERE worker_id=? AND active_job_id=?").run(workerId, jobId);
    return true;
  }

  private async execute(jobId: string) {
    const generation = this.db.transaction(() => {
      this.db.prepare("UPDATE jobs SET runtime_generation=runtime_generation+1 WHERE job_id=?").run(jobId);
      return (this.db.prepare("SELECT runtime_generation g FROM jobs WHERE job_id=?").get(jobId) as { g: number }).g;
    })();
    const job = { ...(this.db.prepare("SELECT j.*,s.workspace_id,s.workspace_version,s.repo_id,s.path FROM jobs j JOIN sessions s USING(session_id) WHERE j.job_id=?").get(jobId) as any), runtime_generation: generation };
    this.running.add(jobId);
    let failure: unknown;
    try {
      if (this.runJob) await this.runJob(job); else await this.runPi(job);
    } catch (error) { failure = error; } finally { this.running.delete(jobId); }
    if (this.closed) return;
    const unresolved = this.db.prepare("SELECT call_id FROM runtime_calls WHERE job_id=? AND status IN ('dispatched','unknown')").all(jobId);
    const state = (this.db.prepare("SELECT state FROM jobs WHERE job_id=?").get(jobId) as { state: string }).state;
    if (state === "running" && unresolved.length) this.attention(job.worker_id, jobId, "run_ended_with_unresolved_calls", { calls: unresolved, error: String(failure ?? "") });
    else if (state === "running") this.db.prepare("UPDATE jobs SET state='failed' WHERE job_id=? AND state='running'").run(jobId);
    if (failure) console.error("execution failed", String(failure));
    this.release(job.worker_id, jobId);
  }

  private current(job: any) {
    const row = this.db.prepare("SELECT state,runtime_generation FROM jobs WHERE job_id=?").get(job.job_id) as { state: string; runtime_generation: number };
    return row.state === "running" && row.runtime_generation === job.runtime_generation && !this.closed;
  }

  /** Rebuild the Pi transcript from SQLite; a partial session file is never trusted. */
  transcript(jobId: string) {
    const entries = this.db.prepare("SELECT entry_key,turn_key,message_json FROM runtime_history WHERE job_id=? ORDER BY history_seq").all(jobId) as Array<{ entry_key: string; turn_key: string | null; message_json: string | null }>;
    const messages: any[] = [];
    for (const entry of entries) {
      if (entry.message_json) { messages.push(JSON.parse(entry.message_json)); continue; }
      const turn = this.db.prepare("SELECT assistant_json FROM runtime_turns WHERE job_id=? AND turn_key=?").get(jobId, entry.turn_key) as { assistant_json: string };
      const assistant = JSON.parse(turn.assistant_json);
      const calls = this.db.prepare("SELECT * FROM runtime_calls WHERE job_id=? AND turn_key=? ORDER BY call_seq").all(jobId, entry.turn_key) as CallRow[];
      const intents = assistant.content.filter((part: any) => part.type === "toolCall");
      if (intents.length !== calls.length || intents.some((intent: any, i: number) => intent.id !== calls[i].call_id || intent.name !== calls[i].tool_name || !isDeepStrictEqual(intent.arguments ?? {}, JSON.parse(calls[i].arguments_json))))
        throw new Error("assistant_batch_does_not_match_committed_calls");
      messages.push(assistant);
      for (const call of calls) {
        if (call.status !== "completed") throw new Error("transcript_has_unresolved_call");
        messages.push({ role: "toolResult", toolCallId: call.call_id, toolName: call.tool_name, ...toolOutput(JSON.parse(call.result_json!)), timestamp: call.completed_at ?? 0 });
      }
    }
    if (!messages.some((m) => m.role === "user")) throw new Error("durable_user_history_required");
    return messages;
  }

  async runPi(job: any) {
    const dataDir = this.options.dataDir ?? process.env.DATA_DIR ?? "./data";
    const fakeMode = Boolean(this.options.fakeScript) || process.env.P2_FAKE_MODEL === "1";
    const provider = fakeMode ? "openai" : (process.env.MODEL_PROVIDER ?? "openrouter");
    const modelName = fakeMode ? "gpt-4o-mini" : (process.env.MODEL_NAME ?? "deepseek/deepseek-v4.1-flash");
    const apiKey = fakeMode ? "p2-scripted-provider" : (process.env.MODEL_API_KEY ?? process.env.OPENROUTER_API_KEY);
    if (!apiKey) throw new Error("MODEL_API_KEY (or OPENROUTER_API_KEY) is required to execute jobs");
    this.db.prepare("INSERT OR IGNORE INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)").run(job.job_id, `user:${job.job_id}`, JSON.stringify({ role: "user", content: [{ type: "text", text: job.input_text }], timestamp: job.created_at }));
    // Committed intents from an earlier run finish first, in order, with their original IDs.
    const open = this.db.prepare("SELECT call_id FROM runtime_calls WHERE job_id=? AND status<>'completed' ORDER BY call_seq").all(job.job_id) as Array<{ call_id: string }>;
    for (const { call_id } of open) {
      if (!this.current(job)) return;
      await this.dispatch(job.job_id, call_id);
    }
    if (!this.current(job)) return;
    const messages = this.transcript(job.job_id);
    const pi = await import("@earendil-works/pi-coding-agent");
    const ai = await import("@earendil-works/pi-ai/compat");
    const typebox = await import("typebox");
    const runtime = await pi.ModelRuntime.create({ authPath: resolve(dataDir, "pi-auth.json"), modelsPath: null, modelsStorePath: resolve(dataDir, "pi-models.json"), refreshOnCreate: false });
    await runtime.setRuntimeApiKey(provider as any, apiKey);
    const model = ai.getModel(provider as any, modelName); if (!model) throw new Error(`unknown Pi model ${provider}/${modelName}`);
    const sessionDir = resolve(dataDir, "pi-sessions", job.session_id);
    const tools = [
      { name: "read", label: "read", description: "Read bounded UTF-8 text from the fixed remote workspace.", parameters: typebox.Type.Object({ path: typebox.Type.String(), offset: typebox.Type.Optional(typebox.Type.Integer({ minimum: 0 })), limit: typebox.Type.Optional(typebox.Type.Integer({ minimum: 1, maximum: 16384 })) }), execute: async (id: string) => this.piTool(job, id) },
      { name: "write", label: "write", description: "Atomically write a UTF-8 file in the fixed remote workspace. expected_hash is the current SHA-256 or 'missing'.", parameters: typebox.Type.Object({ path: typebox.Type.String(), content: typebox.Type.String(), expected_hash: typebox.Type.String() }), execute: async (id: string) => this.piTool(job, id) },
      { name: "bash", label: "bash", description: "Run a non-interactive command in the fixed remote workspace. It is stopped after timeout_secs (default 600, at most 1800). The first 64 KiB of each output stream is returned.", parameters: typebox.Type.Object({ command: typebox.Type.String(), timeout_secs: typebox.Type.Optional(typebox.Type.Integer({ minimum: 1, maximum: 1800 })) }), execute: async (id: string) => this.piTool(job, id) },
    ];
    const mod = await import("./pi-runtime.js");
    const manager = pi.SessionManager.create(job.path, sessionDir);
    for (const message of messages) manager.appendMessage(structuredClone(message));
    let session: any, finished = false, modelError: string | undefined;
    try {
      ({ session } = await mod.createPiSession({
        role: "worker", cwd: job.path, agentDir: resolve(dataDir, "pi-agent"), sessionDir, sessionManager: manager, model, modelRuntime: runtime, customTools: tools,
        commitAssistantTurn: async ({ turnKey, assistantMessage, calls }: any) => this.commitTurn(job, turnKey, assistantMessage, calls),
        onAssistantTurn: async ({ message }: any) => {
          if (message.stopReason === "error" || message.stopReason === "aborted") { modelError = message.errorMessage ?? message.stopReason; return; }
          if (message.content?.some((c: any) => c.type === "toolCall")) return;
          finished = this.commitFinal(job, message);
        },
      }));
      if (fakeMode) {
        const faux = await import("@earendil-works/pi-ai");
        const core = faux.createFauxCore({ provider: "openai", api: "openai", models: [{ id: "gpt-4o-mini" }] });
        const committedTurns = messages.filter((m) => m.role === "assistant").length;
        core.setResponses((this.options.fakeScript?.(job) ?? p2Script(job)).slice(committedTurns).map((step) => "text" in step
          ? faux.fauxAssistantMessage(step.text)
          : faux.fauxAssistantMessage(faux.fauxToolCall(step.tool, step.arguments as any, { id: step.id ?? `${job.job_id}-${step.tool}-${randomUUID()}` }), { stopReason: "toolUse" })));
        session.agent.streamFunction = core.streamSimple;
      }
      for (let turn = 0; !finished && !modelError && turn < MAX_MODEL_TURNS && this.current(job); turn++) await session.agent.continue();
      if (modelError) throw new Error(`model_error: ${modelError}`);
      if (!finished && this.current(job)) throw new Error("model_turn_limit");
    } finally { session?.dispose(); await (runtime as any).dispose?.(); }
  }

  private commitTurn(job: any, turnKey: string, assistantMessage: any, calls: any[]) {
    const fingerprint = hash({ assistantMessage, calls });
    let inserted = false;
    const committed = this.db.transaction(() => {
      if (!this.current(job)) return false;
      const old = this.db.prepare("SELECT content_hash FROM runtime_turns WHERE job_id=? AND turn_key=?").get(job.job_id, turnKey) as any;
      if (old) { if (old.content_hash !== fingerprint) throw new Error("turn_checkpoint_conflict"); return true; }
      inserted = true;
      this.db.prepare("INSERT INTO runtime_turns VALUES(?,?,?,?,?)").run(job.job_id, turnKey, JSON.stringify(assistantMessage), fingerprint, this.now());
      const add = this.db.prepare("INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status) VALUES(?,?,?,?,?,?,?,'committed')");
      let seq = (this.db.prepare("SELECT COALESCE(MAX(call_seq),0) n FROM runtime_calls WHERE job_id=?").get(job.job_id) as any).n;
      for (const c of calls) {
        seq++;
        const request = { worker_id: job.worker_id, job_id: job.job_id, call_id: c.id, call_seq: seq, workspace_id: job.workspace_id, config_version: job.workspace_version, tool: c.name, arguments: c.arguments ?? {} };
        add.run(job.job_id, turnKey, c.id, seq, requestHash(request), c.name, JSON.stringify(c.arguments ?? {}));
      }
      this.db.prepare("INSERT INTO runtime_history(job_id,entry_key,turn_key,message_json) VALUES(?,?,?,NULL)").run(job.job_id, `turn:${turnKey}`, turnKey);
      return true;
    })();
    if (inserted) mainFault("before_dispatch");
    return committed;
  }

  /** The final answer and the job outcome commit together, so recovery never asks the model again. */
  private commitFinal(job: any, message: any) {
    return this.db.transaction(() => {
      if (!this.current(job)) return false;
      this.db.prepare("INSERT INTO runtime_history(job_id,entry_key,message_json) VALUES(?,?,?)").run(job.job_id, `final:${job.job_id}`, JSON.stringify(message));
      this.db.prepare("INSERT INTO messages(message_id,session_id,job_id,seq,content_json) SELECT ?,?,?,COALESCE(MAX(seq),0)+1,? FROM messages WHERE session_id=?").run(randomUUID(), job.session_id, job.job_id, JSON.stringify({ role: "assistant", content: message.content }), job.session_id);
      this.db.prepare("UPDATE jobs SET state='succeeded' WHERE job_id=? AND state='running'").run(job.job_id);
      return true;
    })();
  }

  async piTool(job: any, callId: string) {
    if (!this.current(job)) throw new Error("job_not_running");
    return toolOutput(await this.dispatch(job.job_id, callId));
  }
}

function p2Script(job: any): ScriptStep[] {
  const largeContent = "P2 large payload block\n".repeat(6000);
  return [
    { tool: "read", arguments: { path: "README.md", offset: 0, limit: 200 }, id: `${job.job_id}-read` },
    { tool: "write", arguments: { path: "README.md", content: "P2 controlled fixture updated by remote worker; large-frame run verified", expected_hash: process.env.P2_FAKE_README_HASH ?? "781a5cbce3e95d0c8591508ad2557189dc2189cf7f96034aa06b8e519c1fdf8c" }, id: `${job.job_id}-write` },
    { tool: "write", arguments: { path: "large.txt", content: largeContent, expected_hash: "missing" }, id: `${job.job_id}-large-write` },
    { tool: "bash", arguments: { command: `./verify.sh && test "$(wc -c < large.txt | tr -d ' ')" -eq ${Buffer.byteLength(largeContent)}` }, id: `${job.job_id}-bash` },
    { text: "Read README.md, updated it atomically, transferred a large file in bounded frames, and the remote validation script passed." },
  ];
}

export function newJobId() { return randomUUID(); }

/** How long a dispatched call may go without a result before it is unknown. */
function resultTimeoutMs(row: CallRow) {
  if (row.tool_name !== "bash") return TOOL_RESULT_TIMEOUT_MS;
  const requested = JSON.parse(row.arguments_json).timeout_secs;
  const secs = Number.isInteger(requested) && requested >= 1 && requested <= 1800 ? requested : 600;
  return secs * 1000 + STOP_MARGIN_MS;
}

/** A session stays usable only while its worker still registers the exact workspace it bound. */
export function workspaceCurrent(db: Database.Database, sessionId: string) {
  return Boolean(db.prepare("SELECT 1 FROM sessions s JOIN workspaces w ON w.worker_id=s.worker_id AND w.workspace_id=s.workspace_id AND w.config_version=s.workspace_version AND w.path=s.path AND w.repo_id=s.repo_id WHERE s.session_id=?").get(sessionId));
}
