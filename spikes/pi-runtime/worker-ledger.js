import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Provisional spike-json-v1, NOT an RFC 8785 implementation. Reject values that
// JSON would silently drop/coerce. Production Rust/JS must share RFC fixtures.
export function requestHash(request) {
  function normalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length || Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i)).some((present) => !present)) throw new TypeError('sparse or decorated arrays are not JSON');
      return value.map(normalize);
    }
    if (value && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
    }
    throw new TypeError('request must contain only finite JSON values');
  }
  return createHash('sha256').update(JSON.stringify(normalize(request))).digest('hex');
}

export class SqliteWorkerLedger {
  constructor(filename, { workerId, bootId = randomUUID() }) {
    if (!workerId || !bootId) throw new TypeError('worker and boot identity required');
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledger_meta (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), worker_id TEXT NOT NULL, ledger_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_calls (
        job_id TEXT NOT NULL, call_id TEXT NOT NULL, call_seq INTEGER NOT NULL,
        request_hash TEXT NOT NULL, request_json TEXT NOT NULL, boot_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('accepted','running','completed')),
        result_json TEXT, PRIMARY KEY(job_id, call_id), UNIQUE(call_id), UNIQUE(job_id, call_seq),
        CHECK((status = 'completed' AND result_json IS NOT NULL) OR (status != 'completed' AND result_json IS NULL))
      );
      CREATE TABLE IF NOT EXISTS job_floors (job_id TEXT PRIMARY KEY, retired_through INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_tombstones (call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, call_seq INTEGER NOT NULL, request_hash TEXT NOT NULL);
    `);
    this.db.prepare('INSERT OR IGNORE INTO ledger_meta VALUES (1, ?, ?)').run(workerId, randomUUID());
    this.identity = { ...this.db.prepare('SELECT worker_id AS workerId, ledger_id AS ledgerId FROM ledger_meta').get(), bootId };
    if (this.identity.workerId !== workerId) { this.db.close(); throw new Error('worker identity conflict'); }
  }
  close() { this.db.close(); }

  observe(request) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM worker_calls WHERE job_id = ? AND call_id = ?').get(request.jobId, request.callId);
      const floor = this.db.prepare('SELECT retired_through FROM job_floors WHERE job_id = ?').get(request.jobId)?.retired_through ?? 0;
      if (!row) {
        const tombstone = this.db.prepare('SELECT * FROM worker_tombstones WHERE call_id = ?').get(request.callId);
        if (tombstone) return { ...this.identity, status: tombstone.job_id === request.jobId && tombstone.call_seq === request.callSeq && tombstone.request_hash === requestHash(request) ? 'unknown' : 'conflict', floor, authoritative: true };
        const idOwner = this.db.prepare('SELECT job_id FROM worker_calls WHERE call_id = ?').get(request.callId);
        const sequenceOwner = this.db.prepare('SELECT call_id FROM worker_calls WHERE job_id = ? AND call_seq = ?').get(request.jobId, request.callSeq);
        return { ...this.identity, status: idOwner || sequenceOwner ? 'conflict' : request.callSeq <= floor ? 'unknown' : 'not_accepted', floor, authoritative: true };
      }
      return { ...this.identity, status: row.status, acceptedBootId: row.boot_id, requestHash: row.request_hash,
        callSeq: row.call_seq, result: row.result_json === null ? null : JSON.parse(row.result_json), authoritative: true };
    })();
  }

  accept(request) {
    const hash = requestHash(request);
    return this.db.transaction(() => {
      if (request.workerId !== this.identity.workerId || request.ledgerId !== this.identity.ledgerId || !Number.isSafeInteger(request.callSeq) || request.callSeq < 1) throw new Error('invalid request identity');
      const observed = this.observe(request);
      if (['accepted', 'running', 'completed'].includes(observed.status)) {
        if (observed.requestHash !== hash || observed.callSeq !== request.callSeq) throw new Error('request conflict');
        return observed;
      }
      if (observed.status !== 'not_accepted') throw new Error('missing deduplication proof');
      if (this.db.prepare("SELECT 1 FROM worker_calls WHERE status != 'completed'").get()) throw new Error('worker has an unresolved active call');
      this.db.prepare(`INSERT INTO worker_calls VALUES (?, ?, ?, ?, ?, ?, 'accepted', NULL)`).run(request.jobId, request.callId, request.callSeq, hash, JSON.stringify(request), this.identity.bootId);
      return this.observe(request);
    }).immediate();
  }

  start(request) {
    return this.db.transaction(() => {
      const row = this.observe(request);
      if (row.requestHash !== requestHash(request) || row.status !== 'accepted' || row.acceptedBootId !== this.identity.bootId) throw new Error('cannot safely start call');
      this.db.prepare("UPDATE worker_calls SET status = 'running' WHERE job_id = ? AND call_id = ?").run(request.jobId, request.callId);
    }).immediate();
  }

  complete(request, result) {
    validateResult(request, result);
    return this.db.transaction(() => {
      const row = this.observe(request);
      if (row.requestHash !== requestHash(request)) throw new Error('request conflict');
      if (row.status === 'completed') {
        if (!isDeepStrictEqual(row.result, result)) throw new Error('result conflict');
        return false;
      }
      if (row.status !== 'running' || row.acceptedBootId !== this.identity.bootId) throw new Error('cannot complete unknown call');
      this.db.prepare("UPDATE worker_calls SET status = 'completed', result_json = ? WHERE job_id = ? AND call_id = ?").run(JSON.stringify(result), request.jobId, request.callId);
      return true;
    }).immediate();
  }

  // Only after the host's result commit/ack. The floor survives detailed row GC.
  retireThrough(jobId, callSeq) {
    if (!Number.isSafeInteger(callSeq) || callSeq < 1) throw new TypeError('invalid floor');
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM worker_calls WHERE job_id = ? AND call_seq <= ? AND status != 'completed'").get(jobId, callSeq)) throw new Error('cannot retire unresolved calls');
      this.db.prepare(`INSERT INTO job_floors VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET retired_through = MAX(retired_through, excluded.retired_through)`).run(jobId, callSeq);
      this.db.prepare('INSERT OR IGNORE INTO worker_tombstones SELECT call_id, job_id, call_seq, request_hash FROM worker_calls WHERE job_id = ? AND call_seq <= ?').run(jobId, callSeq);
      this.db.prepare('DELETE FROM worker_calls WHERE job_id = ? AND call_seq <= ?').run(jobId, callSeq);
    }).immediate();
  }
}

function validateResult(request, result) {
  if (result?.role !== 'toolResult' || result.toolCallId !== request.callId || result.toolName !== request.toolName || !Array.isArray(result.content) || typeof result.isError !== 'boolean' || !Number.isFinite(result.timestamp)) throw new Error('result identity/shape conflict');
  requestHash(result); // Reject silent JSON coercion before caching/importing.
}

/** Trusted binding is supplied by host authentication/config validation, never
 * copied from a worker's register frame. This spike has no network trust layer. */
export class WorkerReconciler {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS host_worker_bindings (
      job_id TEXT NOT NULL, turn_key TEXT NOT NULL, call_id TEXT NOT NULL,
      request_json TEXT NOT NULL, request_hash TEXT NOT NULL,
      PRIMARY KEY(job_id, turn_key, call_id)
    )`);
  }
  bind({ jobId, turnKey, callId, trustedTarget, sessionId, timeoutMs }) {
    const call = this.store.readAuthorizedCall(jobId, turnKey, callId);
    if (!call) throw new Error('call is not committed');
    for (const field of ['workerId', 'ledgerId', 'workspaceId', 'workspaceVersion']) {
      if (typeof trustedTarget?.[field] !== 'string' || !trustedTarget[field]) throw new TypeError('verified target required');
    }
    if (!sessionId || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('session/timeout required');
    const { workerId, ledgerId, workspaceId, workspaceVersion } = trustedTarget;
    const request = { jobId, turnKey, sessionId, callId, callSeq: call.callSeq, workerId, ledgerId, workspaceId, workspaceVersion, toolName: call.name, arguments: call.arguments, timeoutMs };
    const hash = requestHash(request);
    return this.store.db.transaction(() => {
      const old = this.#binding(jobId, turnKey, callId);
      if (old) {
        if (old.request_hash !== hash) throw new Error('binding conflict');
        return JSON.parse(old.request_json);
      }
      if (this.store.readAuthorizedCall(jobId, turnKey, callId).status !== 'committed') throw new Error('cannot infer original binding after dispatch');
      this.store.db.prepare('INSERT INTO host_worker_bindings VALUES (?, ?, ?, ?, ?)').run(jobId, turnKey, callId, JSON.stringify(request), hash);
      return request;
    }).immediate();
  }
  #binding(jobId, turnKey, callId) {
    return this.store.db.prepare('SELECT * FROM host_worker_bindings WHERE job_id = ? AND turn_key = ? AND call_id = ?').get(jobId, turnKey, callId);
  }
  reconcile({ jobId, turnKey, callId, verifiedIdentity, ledger }) {
    const blocked = (reason) => ({ action: 'needs_attention', reason });
    const binding = this.#binding(jobId, turnKey, callId);
    const call = this.store.readAuthorizedCall(jobId, turnKey, callId);
    if (!binding || !call) return blocked('missing original host binding');
    const request = JSON.parse(binding.request_json);
    if (requestHash(request) !== binding.request_hash || request.callSeq !== call.callSeq || request.toolName !== call.name || !isDeepStrictEqual(request.arguments, call.arguments)) return blocked('local request contradiction');
    if (!verifiedIdentity || verifiedIdentity.workerId !== request.workerId || verifiedIdentity.ledgerId !== request.ledgerId || !verifiedIdentity.bootId) return blocked('unverified or changed ledger');
    let observed;
    try { observed = ledger.observe(request); } catch { return blocked('ledger unavailable'); }
    if (observed.workerId !== verifiedIdentity.workerId || observed.ledgerId !== verifiedIdentity.ledgerId || observed.bootId !== verifiedIdentity.bootId || observed.authoritative !== true) return blocked('untrusted observation');
    if (['completed', 'accepted', 'running'].includes(observed.status) && (observed.requestHash !== binding.request_hash || observed.callSeq !== request.callSeq)) return blocked('worker request contradiction');
    if (observed.status === 'completed') {
      try {
        validateResult(request, observed.result);
        if (call.status === 'completed' && !isDeepStrictEqual(call.result, observed.result)) return blocked('local result contradiction');
        this.store.db.transaction(() => {
          this.store.markDispatched(jobId, turnKey, callId);
          this.store.recordResult(jobId, turnKey, callId, observed.result);
        }).immediate();
      } catch { return blocked('result import conflict'); }
      return { action: 'completed', result: observed.result };
    }
    if (call.status === 'completed') return blocked('completed local call missing from worker');
    if (['accepted', 'running'].includes(observed.status)) {
      return observed.acceptedBootId === verifiedIdentity.bootId ? { action: 'observe', status: observed.status } : blocked('worker restarted with unresolved call');
    }
    if (observed.status !== 'not_accepted' || !Number.isSafeInteger(observed.floor) || request.callSeq <= observed.floor) return blocked('no authoritative absence proof');
    const earlier = this.store.db.prepare("SELECT 1 FROM runtime_calls WHERE job_id = ? AND call_seq < ? AND status != 'completed'").get(jobId, call.callSeq);
    if (earlier) return { action: 'wait', reason: 'earlier serial call unresolved' };
    return { action: 'dispatch_same_request', request };
  }
}
