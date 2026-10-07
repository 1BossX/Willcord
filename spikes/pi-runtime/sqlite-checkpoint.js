import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

export class TurnConflictError extends Error {
  constructor(jobId, turnKey) {
    super(`turn key already exists with different contents: ${jobId}/${turnKey}`);
    this.name = 'TurnConflictError';
  }
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeJson(value[key])]));
  }
  return value;
}

function json(value) {
  return JSON.stringify(normalizeJson(value));
}

function parse(value) {
  return value === null || value === undefined ? null : JSON.parse(value);
}

/**
 * SQLite-backed checkpoint for the runtime seam spike. A committed turn is the
 * durable authority for its tool calls; callers must authorize through this
 * store before dispatching any side effect.
 */
export class SqliteCheckpointStore {
  constructor(filename) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.#createSchema();
  }

  close() {
    this.db.close();
  }

  persistTurn({ jobId, turnKey, assistantMessage, calls }) {
    this.#validateTurnInput({ jobId, turnKey, assistantMessage, calls });
    const canonicalTurn = json({ assistantMessage, calls });
    const fingerprint = createHash('sha256').update(canonicalTurn).digest('hex');

    return this.db.transaction(() => {
      const existing = this.db.prepare(`
        SELECT content_hash FROM runtime_turns WHERE job_id = ? AND turn_key = ?
      `).get(jobId, turnKey);
      if (existing) {
        if (existing.content_hash !== fingerprint) throw new TurnConflictError(jobId, turnKey);
        return { inserted: false, idempotent: true, fingerprint };
      }

      this.db.prepare(`
        INSERT INTO runtime_turns (job_id, turn_key, assistant_json, content_hash, committed_at)
        VALUES (?, ?, ?, ?, unixepoch())
      `).run(jobId, turnKey, json(assistantMessage), fingerprint);

      const insertCall = this.db.prepare(`
        INSERT INTO runtime_calls
          (job_id, turn_key, call_id, call_seq, tool_name, arguments_json, status, committed_at)
        VALUES (?, ?, ?, ?, ?, ?, 'committed', unixepoch())
      `);
      let callSeq = this.db.prepare(`
        SELECT COALESCE(MAX(call_seq), 0) AS max_seq FROM runtime_calls WHERE job_id = ?
      `).get(jobId).max_seq;
      calls.forEach((call) => {
        callSeq += 1;
        insertCall.run(jobId, turnKey, call.id, callSeq, call.name, json(call.arguments ?? {}));
      });

      this.db.prepare(`INSERT INTO runtime_history (job_id, entry_key, turn_key)
        VALUES (?, ?, ?)`).run(jobId, `turn:${turnKey}`, turnKey);

      return { inserted: true, idempotent: false, fingerprint };
    }).immediate();
  }

  readTurn(jobId, turnKey) {
    const turn = this.db.prepare(`
      SELECT job_id, turn_key, assistant_json, content_hash, committed_at
      FROM runtime_turns WHERE job_id = ? AND turn_key = ?
    `).get(jobId, turnKey);
    if (!turn) return null;
    return {
      jobId: turn.job_id,
      turnKey: turn.turn_key,
      assistantMessage: parse(turn.assistant_json),
      fingerprint: turn.content_hash,
      committedAt: turn.committed_at,
      calls: this.#readCalls(jobId, turnKey),
    };
  }

  /** Commit user/base/non-tool messages before allowing Pi to consume them. */
  appendHistory(jobId, entryKey, message) {
    if (typeof jobId !== 'string' || !jobId || typeof entryKey !== 'string' || !entryKey || entryKey.startsWith('turn:') || !message || !['user', 'assistant'].includes(message.role)) {
      throw new TypeError('history requires jobId, entryKey and a supported message');
    }
    if (message.role === 'assistant' && (!Array.isArray(message.content) || message.content.some((part) => part.type === 'toolCall'))) {
      throw new TypeError('tool-call messages must use persistTurn');
    }
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT message_json FROM runtime_history WHERE job_id = ? AND entry_key = ?').get(jobId, entryKey);
      if (existing) {
        if (existing.message_json !== json(message)) throw new TurnConflictError(jobId, entryKey);
        return false;
      }
      this.db.prepare('INSERT INTO runtime_history (job_id, entry_key, message_json) VALUES (?, ?, ?)').run(jobId, entryKey, json(message));
      return true;
    }).immediate();
  }

  readHistory(jobId) {
    return this.db.prepare('SELECT entry_key, turn_key, message_json FROM runtime_history WHERE job_id = ? ORDER BY history_seq').all(jobId)
      .map((row) => row.turn_key === null
        ? { entryKey: row.entry_key, message: parse(row.message_json) }
        : { entryKey: row.entry_key, turn: this.readTurn(jobId, row.turn_key) });
  }

  readAuthorizedCall(jobId, turnKey, callId) {
    const row = this.db.prepare(`
      SELECT c.job_id, c.turn_key, c.call_id, c.call_seq, c.tool_name,
             c.arguments_json, c.status, c.result_json
      FROM runtime_calls AS c
      INNER JOIN runtime_turns AS t
        ON t.job_id = c.job_id AND t.turn_key = c.turn_key
      WHERE c.job_id = ? AND c.turn_key = ? AND c.call_id = ?
    `).get(jobId, turnKey, callId);
    if (!row) return null;
    return this.#callFromRow(row);
  }

  markDispatched(jobId, turnKey, callId) {
    return this.db.transaction(() => {
      const authorized = this.readAuthorizedCall(jobId, turnKey, callId);
      if (!authorized) throw new Error(`tool call is not committed: ${jobId}/${turnKey}/${callId}`);
      if (authorized.status === 'dispatched' || authorized.status === 'completed') return false;
      const changed = this.db.prepare(`
        UPDATE runtime_calls SET status = 'dispatched'
        WHERE job_id = ? AND turn_key = ? AND call_id = ? AND status = 'committed'
      `).run(jobId, turnKey, callId).changes;
      return changed === 1;
    }).immediate();
  }

  recordResult(jobId, turnKey, callId, result) {
    return this.db.transaction(() => {
      const authorized = this.readAuthorizedCall(jobId, turnKey, callId);
      if (!authorized) throw new Error(`tool call is not committed: ${jobId}/${turnKey}/${callId}`);
      if (authorized.status === 'completed') {
        if (json(authorized.result) === json(result)) return false;
        throw new TurnConflictError(jobId, `${turnKey}/${callId}/result`);
      }
      if (authorized.status !== 'dispatched') {
        throw new Error(`tool call must be dispatched before recording a result: ${jobId}/${turnKey}/${callId}`);
      }
      this.db.prepare(`
        UPDATE runtime_calls SET status = 'completed', result_json = ?, completed_at = unixepoch()
        WHERE job_id = ? AND turn_key = ? AND call_id = ?
      `).run(json(result), jobId, turnKey, callId);
      return true;
    }).immediate();
  }

  findIncompleteTurns(jobId = undefined) {
    const rows = jobId === undefined
      ? this.db.prepare(`
          SELECT DISTINCT t.job_id, t.turn_key
          FROM runtime_turns AS t JOIN runtime_calls AS c
            ON c.job_id = t.job_id AND c.turn_key = t.turn_key
          WHERE c.status != 'completed' ORDER BY t.committed_at, t.job_id, t.turn_key
        `).all()
      : this.db.prepare(`
          SELECT DISTINCT t.job_id, t.turn_key
          FROM runtime_turns AS t JOIN runtime_calls AS c
            ON c.job_id = t.job_id AND c.turn_key = t.turn_key
          WHERE c.status != 'completed' AND t.job_id = ?
          ORDER BY t.committed_at, t.turn_key
        `).all(jobId);
    return rows.map(({ job_id: id, turn_key: key }) => this.readTurn(id, key));
  }

  #readCalls(jobId, turnKey) {
    return this.db.prepare(`
      SELECT job_id, turn_key, call_id, call_seq, tool_name, arguments_json, status, result_json
      FROM runtime_calls WHERE job_id = ? AND turn_key = ? ORDER BY call_seq
    `).all(jobId, turnKey).map((row) => this.#callFromRow(row));
  }

  #callFromRow(row) {
    return {
      jobId: row.job_id,
      turnKey: row.turn_key,
      callId: row.call_id,
      callSeq: row.call_seq,
      name: row.tool_name,
      arguments: parse(row.arguments_json),
      status: row.status,
      result: parse(row.result_json),
    };
  }

  #validateTurnInput({ jobId, turnKey, assistantMessage, calls }) {
    if (typeof jobId !== 'string' || jobId.length === 0) throw new TypeError('jobId is required');
    if (typeof turnKey !== 'string' || turnKey.length === 0) throw new TypeError('turnKey is required');
    if (!assistantMessage || typeof assistantMessage !== 'object' || Array.isArray(assistantMessage)) {
      throw new TypeError('assistantMessage must be an object');
    }
    if (!Array.isArray(calls)) throw new TypeError('calls must be an array');
    for (const call of calls) {
      if (typeof call?.id !== 'string' || !call.id) throw new TypeError('every call needs a stable id');
      if (typeof call.name !== 'string' || !call.name) throw new TypeError('every call needs a tool name');
      if (call.arguments !== undefined && (call.arguments === null || typeof call.arguments !== 'object')) {
        throw new TypeError('call arguments must be an object or array');
      }
    }
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_turns (
        job_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        assistant_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        committed_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, turn_key)
      );

      CREATE TABLE IF NOT EXISTS runtime_calls (
        job_id TEXT NOT NULL,
        turn_key TEXT NOT NULL,
        call_id TEXT NOT NULL,
        call_seq INTEGER NOT NULL CHECK (call_seq > 0),
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('committed', 'dispatched', 'completed')),
        result_json TEXT,
        committed_at INTEGER NOT NULL,
        completed_at INTEGER,
        PRIMARY KEY (job_id, turn_key, call_id),
        UNIQUE (job_id, call_seq),
        FOREIGN KEY (job_id, turn_key) REFERENCES runtime_turns(job_id, turn_key) ON DELETE CASCADE,
        CHECK ((status = 'completed' AND result_json IS NOT NULL AND completed_at IS NOT NULL)
            OR (status != 'completed' AND result_json IS NULL AND completed_at IS NULL))
      );

      CREATE TABLE IF NOT EXISTS runtime_history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        entry_key TEXT NOT NULL,
        turn_key TEXT,
        message_json TEXT,
        UNIQUE (job_id, entry_key),
        FOREIGN KEY (job_id, turn_key) REFERENCES runtime_turns(job_id, turn_key),
        CHECK ((turn_key IS NULL AND message_json IS NOT NULL)
          OR (turn_key IS NOT NULL AND message_json IS NULL))
      );
    `);
  }
}
