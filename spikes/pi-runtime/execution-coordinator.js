import { createPiSession, ROLE_TOOLS } from './pi-runtime.js';
import { SqliteRuntimeStateStore } from './sqlite-runtime-state.js';
import { WorkerReconciler, requestHash } from './worker-ledger.js';
import { recoverTranscript } from './transcript-recovery.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';

const MAIN_TOOLS = [
  { name: 'list_workers', parameters: Type.Object({}, { additionalProperties: false }) },
  { name: 'delegate', parameters: Type.Object({ input: Type.String() }, { additionalProperties: false }) },
  { name: 'get_job', parameters: Type.Object({ childJobId: Type.String() }, { additionalProperties: false }) },
].map((tool) => ({ ...tool, label: tool.name, description: tool.name }));

export function piUsage(message) {
  // Pi provider adapters separate uncached input from cache reads/writes.
  const usage = message.usage;
  const values = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => usage?.[key]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('missing authoritative usage');
  const [input, output, cacheRead, cacheWrite] = values;
  return { inputTokens: input + cacheRead + cacheWrite, outputTokens: output };
}

/** Single-owner Main/worker orchestration spike. Transport and identity are
 * injected; production authentication and ownership locks remain deferred. */
export class ExecutionCoordinator {
  constructor({ store, ledger, verifiedIdentity, trustedTarget, sessionId, sessionOptions, tools, execute, timeoutMs = 1000 }) {
    this.store = store;
    this.state = new SqliteRuntimeStateStore(null, { db: store.db });
    this.reconciler = new WorkerReconciler(store);
    Object.assign(this, { ledger, verifiedIdentity, trustedTarget, sessionId, sessionOptions, tools, execute, timeoutMs });
    this.active = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordinator_jobs (
      job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id),
      status TEXT NOT NULL CHECK(status IN ('ready','generating','tools','waiting_children','completed','failed','cancelled','needs_attention','budget_exceeded')),
      cancel_requested INTEGER NOT NULL DEFAULT 0, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS coordinator_attempts (
      job_id TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(job_id, generation)
    );
    CREATE TABLE IF NOT EXISTS coordinator_drafts (job_id TEXT NOT NULL, generation INTEGER NOT NULL, message_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('streaming','committed','interrupted','cancelled')), event_count INTEGER NOT NULL, truncated INTEGER NOT NULL, PRIMARY KEY(job_id,generation));
    CREATE TABLE IF NOT EXISTS coordinator_usage_resolutions (job_id TEXT NOT NULL, generation INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, evidence_json TEXT NOT NULL, retry_prompt TEXT NOT NULL, original_unknown INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(job_id,generation));`);
    this.#upgradeLifecycle();
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordinator_targets (job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id), target_json TEXT NOT NULL, session_id TEXT NOT NULL, timeout_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS coordinator_roles (job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id), role TEXT NOT NULL CHECK(role IN ('main','worker')));
      CREATE TABLE IF NOT EXISTS coordinator_delegations (parent_job_id TEXT NOT NULL REFERENCES runtime_job_state(job_id), turn_key TEXT NOT NULL, call_id TEXT NOT NULL, child_job_id TEXT NOT NULL UNIQUE REFERENCES runtime_job_state(job_id), projected INTEGER NOT NULL DEFAULT 0 CHECK(projected IN (0,1)), result_json TEXT, PRIMARY KEY(parent_job_id, call_id));`);
  }
  #upgradeLifecycle() {
    const schema = this.store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'coordinator_jobs'").get().sql;
    if (schema.includes("'waiting_children'")) return;
    this.store.db.transaction(() => {
      this.store.db.exec(`CREATE TABLE coordinator_jobs_v2 (job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id), status TEXT NOT NULL CHECK(status IN ('ready','generating','tools','waiting_children','completed','failed','cancelled','needs_attention','budget_exceeded')), cancel_requested INTEGER NOT NULL DEFAULT 0, reason TEXT);
        INSERT INTO coordinator_jobs_v2 SELECT job_id,status,cancel_requested,reason FROM coordinator_jobs;
        DROP TABLE coordinator_jobs; ALTER TABLE coordinator_jobs_v2 RENAME TO coordinator_jobs;`);
    }).immediate();
  }
  createJob({ jobId, rootJobId = jobId, parentJobId = null, maxTokens, maxSteps, prompt, role = 'worker' }) {
    this.store.db.transaction(() => {
      if (!['main', 'worker'].includes(role)) throw new Error('unknown role');
      this.state.createJob({ jobId, rootJobId, parentJobId, maxTokens, maxSteps });
      this.store.db.prepare("INSERT INTO coordinator_jobs(job_id,status) VALUES (?, 'ready')").run(jobId);
      this.store.db.prepare('INSERT INTO coordinator_roles VALUES (?, ?)').run(jobId, role);
      this.store.db.prepare('INSERT INTO coordinator_targets VALUES (?, ?, ?, ?)').run(jobId, JSON.stringify(this.trustedTarget), this.sessionId, this.timeoutMs);
      this.store.appendHistory(jobId, 'initial-user', { role: 'user', content: prompt, timestamp: Date.now() });
    }).immediate();
  }
  readJob(jobId) {
    const row = this.store.db.prepare('SELECT * FROM coordinator_jobs WHERE job_id = ?').get(jobId);
    if (!row) throw new Error('unknown coordinator job');
    return { ...this.state.readJob(jobId), role: this.store.db.prepare('SELECT role FROM coordinator_roles WHERE job_id = ?').get(jobId)?.role ?? 'worker', lifecycle: row.status, cancelRequested: Boolean(row.cancel_requested), reason: row.reason };
  }
  #set(jobId, status, reason = null) {
    this.store.db.prepare('UPDATE coordinator_jobs SET status = ?, reason = ? WHERE job_id = ?').run(status, reason, jobId);
  }
  #current(jobId, generation) {
    const job = this.readJob(jobId);
    return job.generation === generation && !job.cancelRequested && ['generating', 'tools', 'waiting_children'].includes(job.lifecycle);
  }
  #hasUnknownAttempt(jobId) {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM coordinator_attempts a
      LEFT JOIN runtime_usage u ON u.job_id = a.job_id AND u.generation = a.generation
      WHERE a.job_id = ? AND u.generation IS NULL LIMIT 1`).get(jobId));
  }
  drafts(jobId) {
    return this.store.db.prepare('SELECT * FROM coordinator_drafts WHERE job_id = ? ORDER BY generation').all(jobId)
      .map((row) => ({ generation: row.generation, message: JSON.parse(row.message_json), status: row.status, eventCount: row.event_count, truncated: Boolean(row.truncated) }));
  }
  #observeDraft(jobId, generation, event) {
    if (!['message_start', 'message_update'].includes(event.type) || event.message?.role !== 'assistant' || !this.#current(jobId, generation)) return;
    const prior = this.store.db.prepare('SELECT status FROM coordinator_drafts WHERE job_id = ? AND generation = ?').get(jobId, generation);
    if (prior && prior.status !== 'streaming') return;
    const message = structuredClone(event.message);
    let serialized = JSON.stringify(message);
    let truncated = false;
    if (Buffer.byteLength(serialized) > 65536) {
      truncated = true;
      message.content = [{ type: 'text', text: '[draft snapshot truncated at 64 KiB]' }];
      serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized) > 65536) serialized = JSON.stringify({ role: 'assistant', content: message.content, timestamp: message.timestamp });
    }
    this.store.db.prepare(`INSERT INTO coordinator_drafts VALUES (?, ?, ?, 'streaming', 1, ?)
      ON CONFLICT(job_id,generation) DO UPDATE SET message_json = excluded.message_json, event_count = event_count + 1, truncated = MAX(truncated, excluded.truncated)`).run(jobId, generation, serialized, Number(truncated));
  }
  #archiveDraft(jobId, generation, status) {
    const draft = this.store.db.prepare('SELECT * FROM coordinator_drafts WHERE job_id = ? AND generation = ?').get(jobId, generation);
    if (!draft || draft.status !== 'streaming') return;
    const partial = JSON.parse(draft.message_json);
    // Uncommitted tool blocks stay in draft/audit storage only. An aborted
    // assistant history entry is diagnostic, never executable intent.
    const message = { ...partial, role: 'assistant', content: Array.isArray(partial.content) ? partial.content.filter((part) => ['text', 'thinking'].includes(part?.type)) : [],
      stopReason: 'aborted', errorMessage: `generation ${generation} ${status}; draft is not committed intent` };
    this.store.appendHistory(jobId, `interrupted-assistant:${generation}`, message);
    this.store.db.prepare('UPDATE coordinator_drafts SET status = ? WHERE job_id = ? AND generation = ?').run(status, jobId, generation);
  }
  #markDraftCommitted(jobId, generation) {
    this.store.db.prepare("UPDATE coordinator_drafts SET status = 'committed' WHERE job_id = ? AND generation = ? AND status = 'streaming'").run(jobId, generation);
  }
  resolveInterrupted({ jobId, generation, verifiedUsage, evidence, prompt }) {
    if (this.active.has(jobId)) throw new Error('cannot resolve active job');
    if (typeof prompt !== 'string' || !prompt || typeof evidence?.source !== 'string' || !evidence.source || typeof evidence.reference !== 'string' || !evidence.reference) throw new Error('verified usage evidence and new user prompt required');
    requestHash(evidence); // Strict finite JSON validation, no silent coercion.
    return this.store.db.transaction(() => {
      const old = this.store.db.prepare('SELECT * FROM coordinator_usage_resolutions WHERE job_id = ? AND generation = ?').get(jobId, generation);
      if (old) {
        if (old.input_tokens !== verifiedUsage?.inputTokens || old.output_tokens !== verifiedUsage?.outputTokens || old.retry_prompt !== prompt || !isDeepStrictEqual(JSON.parse(old.evidence_json), evidence)) throw new Error('interruption resolution conflict');
        return this.readJob(jobId);
      }
      const job = this.readJob(jobId);
      if (job.lifecycle !== 'needs_attention' || job.cancelRequested) throw new Error('only interrupted needs_attention jobs may retry');
      if (this.store.findIncompleteTurns(jobId).length || this.#pendingChildren(jobId).length) throw new Error('unresolved execution or children prevent retry');
      if (this.ledger.db.prepare("SELECT 1 FROM worker_calls WHERE job_id = ? AND status != 'completed'").get(jobId)) throw new Error('worker execution remains unresolved');
      const attempt = this.store.db.prepare('SELECT 1 FROM coordinator_attempts WHERE job_id = ? AND generation = ?').get(jobId, generation);
      const usage = this.store.db.prepare('SELECT 1 FROM runtime_usage WHERE job_id = ? AND generation = ?').get(jobId, generation);
      if (!attempt || usage) throw new Error('generation is not a missing-usage attempt');
      this.#archiveDraft(jobId, generation, 'interrupted');
      this.state.recordVerifiedInterruptedUsage(jobId, generation, verifiedUsage);
      this.store.db.prepare('INSERT INTO coordinator_usage_resolutions VALUES (?, ?, ?, ?, ?, ?, 1)').run(jobId, generation, verifiedUsage.inputTokens, verifiedUsage.outputTokens, JSON.stringify(evidence), prompt);
      if (this.#hasUnknownAttempt(jobId)) { this.#set(jobId, 'needs_attention', 'additional unknown model attempts'); return this.readJob(jobId); }
      this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ?").run(jobId);
      const root = this.store.db.prepare('SELECT max_steps FROM runtime_roots WHERE root_job_id = ?').get(job.rootJobId);
      const attempts = this.store.db.prepare('SELECT COUNT(*) AS count FROM coordinator_attempts a JOIN runtime_job_state j ON j.job_id = a.job_id WHERE j.root_job_id = ?').get(job.rootJobId).count;
      const own = this.store.db.prepare('SELECT COUNT(*) AS count FROM coordinator_attempts WHERE job_id = ?').get(jobId).count;
      if (!this.state.canStartGeneration(jobId).allowed || attempts >= root.max_steps || own >= job.maxSteps) this.#set(jobId, 'budget_exceeded', 'verified interrupted usage exhausted retry budget');
      else {
        this.store.appendHistory(jobId, `retry-user:${generation}`, { role: 'user', content: prompt, timestamp: Date.now() });
        this.#set(jobId, 'ready');
      }
      return this.readJob(jobId);
    }).immediate();
  }
  #account(jobId, generation, message) {
    const usage = piUsage(message);
    const old = this.store.db.prepare('SELECT input_tokens, output_tokens FROM runtime_usage WHERE job_id = ? AND generation = ?').get(jobId, generation);
    if (old) {
      if (old.input_tokens !== usage.inputTokens || old.output_tokens !== usage.outputTokens) throw new Error('conflicting repeated usage');
      return this.state.readJob(jobId).status !== 'budget_exceeded';
    }
    return this.state.recordAssistantUsage(jobId, generation, usage).mayExecuteTools;
  }
  #notExecuted(jobId, turn, call, reason) {
    const result = { role: 'toolResult', toolCallId: call.callId, toolName: call.name,
      content: [{ type: 'text', text: reason }], isError: true, timestamp: Date.now(), details: { notExecuted: true } };
    this.store.markDispatched(jobId, turn.turnKey, call.callId);
    this.store.recordResult(jobId, turn.turnKey, call.callId, result);
  }
  #commitBatch(jobId, generation, entry) {
    return this.store.db.transaction(() => {
      if (!this.#current(jobId, generation)) return false;
      const allowed = this.#account(jobId, generation, entry.assistantMessage);
      this.store.persistTurn({ jobId, ...entry });
      this.#markDraftCommitted(jobId, generation);
      if (this.readJob(jobId).role === 'main') return this.#commitMainBatch(jobId, entry, allowed);
      const target = this.#jobTarget(jobId);
      for (const call of entry.calls) this.reconciler.bind({ jobId, turnKey: entry.turnKey, callId: call.id,
        trustedTarget: target.target, sessionId: target.sessionId, timeoutMs: target.timeoutMs });
      if (!allowed) {
        const turn = this.store.readTurn(jobId, entry.turnKey);
        for (const call of turn.calls) this.#notExecuted(jobId, turn, call, 'Budget exceeded before worker acceptance');
        this.#set(jobId, 'budget_exceeded');
        return false;
      }
      this.#set(jobId, 'tools');
      return true;
    }).immediate();
  }
  #jobTarget(jobId) {
    const row = this.store.db.prepare('SELECT * FROM coordinator_targets WHERE job_id = ?').get(jobId);
    if (row) return { target: JSON.parse(row.target_json), sessionId: row.session_id, timeoutMs: row.timeout_ms };
    // Upgrade old in-flight worker jobs only from their immutable dispatch
    // bindings, never from a newly configured target after restart.
    const bindings = this.store.db.prepare('SELECT request_json FROM host_worker_bindings WHERE job_id = ?').all(jobId).map((row) => JSON.parse(row.request_json));
    if (!bindings.length) throw new Error('legacy job missing original target snapshot');
    const snapshots = bindings.map(({ workerId, ledgerId, workspaceId, workspaceVersion, sessionId, timeoutMs }) => ({ target: { workerId, ledgerId, workspaceId, workspaceVersion }, sessionId, timeoutMs }));
    if (snapshots.some((item) => !isDeepStrictEqual(item, snapshots[0]))) throw new Error('legacy target contradiction');
    this.store.db.prepare('INSERT INTO coordinator_targets VALUES (?, ?, ?, ?)').run(jobId, JSON.stringify(snapshots[0].target), snapshots[0].sessionId, snapshots[0].timeoutMs);
    return snapshots[0];
  }
  failJob(jobId, reason) {
    if (this.active.has(jobId)) throw new Error('cannot fail active job');
    return this.store.db.transaction(() => {
      const job = this.readJob(jobId);
      if (job.lifecycle !== 'ready' || this.store.findIncompleteTurns(jobId).length || this.#pendingChildren(jobId).length) throw new Error('unresolved job cannot be marked failed');
      this.store.db.prepare('UPDATE runtime_job_state SET generation = generation + 1 WHERE job_id = ?').run(jobId);
      this.#set(jobId, 'failed', reason);
      return this.readJob(jobId);
    }).immediate();
  }
  #pendingChildren(parentJobId) {
    return this.store.db.prepare('SELECT * FROM coordinator_delegations WHERE parent_job_id = ? AND projected = 0 ORDER BY rowid').all(parentJobId);
  }
  children(parentJobId) {
    return this.store.db.prepare('SELECT child_job_id FROM coordinator_delegations WHERE parent_job_id = ? ORDER BY rowid').all(parentJobId).map((row) => this.readJob(row.child_job_id));
  }
  #mainResult(jobId, turnKey, call, value, isError = false) {
    const result = { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: JSON.stringify(value) }], details: value, isError, timestamp: Date.now() };
    this.store.markDispatched(jobId, turnKey, call.id);
    this.store.recordResult(jobId, turnKey, call.id, result);
  }
  #commitMainBatch(jobId, entry, allowed) {
    const parent = this.readJob(jobId);
    const turn = this.store.readTurn(jobId, entry.turnKey);
    const target = this.#jobTarget(jobId);
    for (const call of entry.calls) {
      const stored = turn.calls.find((item) => item.callId === call.id);
      if (stored.status === 'completed') continue;
      try {
        const tool = MAIN_TOOLS.find((tool) => tool.name === call.name);
        if (!tool) throw new Error('unknown main tool');
        const args = validateToolArguments(tool, call);
        if (!isDeepStrictEqual(args, call.arguments)) throw new Error('main arguments require transformation');
        if (!allowed) throw new Error('budget exceeded before local acceptance');
      } catch (error) { this.#notExecuted(jobId, turn, stored, error.message); continue; }
      if (call.name === 'delegate') {
        const childId = `child:${createHash('sha256').update(JSON.stringify([jobId, call.id])).digest('hex')}`;
        const old = this.store.db.prepare('SELECT * FROM coordinator_delegations WHERE parent_job_id = ? AND call_id = ?').get(jobId, call.id);
        if (old) throw new Error('delegate identity reused across turns');
        this.createJob({ jobId: childId, rootJobId: parent.rootJobId, parentJobId: jobId, maxTokens: parent.maxTokens, maxSteps: parent.maxSteps, prompt: call.arguments.input, role: 'worker' });
        this.store.db.prepare('UPDATE coordinator_targets SET target_json = ?, session_id = ?, timeout_ms = ? WHERE job_id = ?').run(JSON.stringify(target.target), `session:${childId}`, target.timeoutMs, childId);
        this.store.db.prepare('INSERT INTO coordinator_delegations(parent_job_id,turn_key,call_id,child_job_id) VALUES (?, ?, ?, ?)').run(jobId, entry.turnKey, call.id, childId);
        this.#mainResult(jobId, entry.turnKey, call, { childJobId: childId, status: 'accepted' });
      } else if (call.name === 'list_workers') this.#mainResult(jobId, entry.turnKey, call, { workers: [{ workerId: target.target.workerId, workspaceId: target.target.workspaceId }] });
      else {
        const owned = this.store.db.prepare('SELECT 1 FROM coordinator_delegations WHERE parent_job_id = ? AND child_job_id = ?').get(jobId, call.arguments.childJobId);
        this.#mainResult(jobId, entry.turnKey, call, owned ? { job: this.readJob(call.arguments.childJobId) } : { error: 'child does not belong to parent' }, !owned);
      }
    }
    this.#set(jobId, !allowed ? 'budget_exceeded' : this.#pendingChildren(jobId).length ? 'waiting_children' : 'tools');
    return allowed;
  }
  scanChildren(parentJobId) {
    if (this.active.has(parentJobId)) throw new Error('cannot scan active parent');
    return this.store.db.transaction(() => {
      const parent = this.readJob(parentJobId);
      if (parent.role !== 'main') throw new Error('job is not a main parent');
      let unknown = false;
      for (const row of this.#pendingChildren(parentJobId)) {
        const child = this.readJob(row.child_job_id);
        if (child.parentJobId !== parentJobId || child.rootJobId !== parent.rootJobId) throw new Error('child ownership contradiction');
        if (!child.cancelRequested && !this.active.has(child.jobId) && this.#hasUnknownAttempt(child.jobId)) {
          this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ? AND status = 'running'").run(child.jobId);
          this.#archiveDraft(child.jobId, child.generation, 'interrupted');
          this.#set(child.jobId, 'needs_attention', 'interrupted model attempt; usage unknown');
          unknown = true; continue;
        }
        if (!['completed', 'failed', 'cancelled', 'budget_exceeded'].includes(child.lifecycle)) {
          unknown ||= child.lifecycle === 'needs_attention'; continue;
        }
        const history = this.store.readHistory(child.jobId);
        const final = history.filter((entry) => entry.message?.role === 'assistant').at(-1)?.message;
        const result = { jobId: child.jobId, parentJobId, rootJobId: child.rootJobId, status: child.lifecycle,
          output: final?.content ?? history.flatMap((entry) => entry.turn?.calls.map((call) => call.result) ?? []), reason: child.reason };
        const serialized = JSON.stringify(result);
        if (row.result_json !== null && row.result_json !== serialized) throw new Error('child result contradiction');
        // Stable source timestamp, not scan time, makes replay idempotent.
        const timestamp = final?.timestamp ?? history[0].message.timestamp;
        this.store.appendHistory(parentJobId, `child-result:${child.jobId}`, { role: 'user', content: JSON.stringify({ type: 'child_result', ...result }), timestamp });
        this.store.db.prepare('UPDATE coordinator_delegations SET projected = 1, result_json = ? WHERE parent_job_id = ? AND call_id = ?').run(serialized, parentJobId, row.call_id);
      }
      const pending = this.#pendingChildren(parentJobId);
      const waitOnly = parent.lifecycle === 'waiting_children' || parent.lifecycle === 'needs_attention' && ['child requires attention', 'child cancellation unresolved', 'cancellation requested'].includes(parent.reason);
      if (pending.length && (waitOnly || parent.cancelRequested)) this.#set(parentJobId, unknown || parent.cancelRequested ? 'needs_attention' : 'waiting_children', unknown ? 'child requires attention' : parent.cancelRequested ? 'child cancellation unresolved' : null);
      else if (!pending.length && parent.cancelRequested) this.#set(parentJobId, 'cancelled');
      else if (this.#hasUnknownAttempt(parentJobId)) this.#set(parentJobId, 'needs_attention', 'interrupted model attempt; usage unknown');
      else if (!pending.length && waitOnly) this.#set(parentJobId, 'ready');
      this.state.finishGeneration(parentJobId, parent.generation);
      return this.readJob(parentJobId);
    }).immediate();
  }
  #findCall(jobId, callId) {
    const row = this.store.db.prepare('SELECT turn_key FROM runtime_calls WHERE job_id = ? AND call_id = ?').all(jobId, callId);
    if (row.length !== 1) throw new Error('ambiguous durable call');
    return row[0].turn_key;
  }
  async #executeCall(jobId, generation, callId, signal) {
    if (!this.#current(jobId, generation)) throw new Error('stale generation cannot execute');
    const turnKey = this.#findCall(jobId, callId);
    if (this.readJob(jobId).role === 'main') {
      const cached = this.store.readAuthorizedCall(jobId, turnKey, callId);
      if (cached.status !== 'completed') throw new Error('local main acceptance is not committed');
      return { ...cached.result, terminate: true };
    }
    const outcome = this.reconciler.reconcile({ jobId, turnKey, callId, verifiedIdentity: this.verifiedIdentity, ledger: this.ledger });
    if (outcome.action === 'completed') return outcome.result;
    if (outcome.action !== 'dispatch_same_request') {
      this.#set(jobId, 'needs_attention', outcome.reason ?? outcome.action);
      throw new Error('call requires reconciliation');
    }
    try {
      const tool = this.tools.find((tool) => tool.name === outcome.request.toolName);
      if (!tool) throw new Error('tool is not in the worker allowlist');
      const original = outcome.request.arguments;
      const prepared = tool.prepareArguments ? tool.prepareArguments(structuredClone(original)) : original;
      const validated = validateToolArguments(tool, { type: 'toolCall', id: callId, name: tool.name, arguments: prepared });
      // Execution and its dedup hash must describe identical arguments. This
      // spike rejects coercion/preparation instead of silently dispatching a
      // different payload from the authoritative assistant intent.
      if (!isDeepStrictEqual(validated, original)) throw new Error('schema requires argument transformation');
    } catch (error) {
      const turn = this.store.readTurn(jobId, turnKey);
      const call = turn.calls.find((call) => call.callId === callId);
      this.store.db.transaction(() => this.#notExecuted(jobId, turn, call, `Invalid original tool arguments: ${error.message}`)).immediate();
      return this.store.readAuthorizedCall(jobId, turnKey, callId).result;
    }
    const job = this.state.readJob(jobId);
    const root = this.store.db.prepare('SELECT * FROM runtime_roots WHERE root_job_id = ?').get(job.rootJobId);
    if (job.inputTokens + job.outputTokens > job.maxTokens || root.input_tokens + root.output_tokens > root.max_tokens || job.steps > job.maxSteps || root.steps > root.max_steps) {
      this.store.db.transaction(() => {
        for (const turn of this.store.findIncompleteTurns(jobId)) {
          for (const call of turn.calls.filter((call) => call.status !== 'completed')) {
            const proof = this.reconciler.reconcile({ jobId, turnKey: turn.turnKey, callId: call.callId, verifiedIdentity: this.verifiedIdentity, ledger: this.ledger });
            if (proof.action === 'completed') continue;
            if (proof.action !== 'dispatch_same_request') { this.#set(jobId, 'needs_attention', 'budget exhausted with unresolved acceptance'); return; }
            this.#notExecuted(jobId, turn, call, 'Shared budget exceeded before worker acceptance');
          }
        }
        this.#set(jobId, 'budget_exceeded');
      }).immediate();
      throw new Error('shared budget exhausted');
    }
    // accept is durable before start/effect. Once running, an interrupted effect
    // must remain unknown; never synthesize a not-executed result for it.
    this.ledger.accept(outcome.request);
    this.store.markDispatched(jobId, turnKey, callId);
    this.ledger.start(outcome.request);
    const value = await this.execute(outcome.request, signal);
    const result = { role: 'toolResult', toolCallId: callId, toolName: outcome.request.toolName,
      content: value.content, details: value.details ?? {}, isError: value.isError ?? false, timestamp: Date.now() };
    this.ledger.complete(outcome.request, result);
    if (this.#current(jobId, generation)) this.store.recordResult(jobId, turnKey, callId, result);
    return result;
  }
  #finish(jobId, generation, message) {
    this.store.db.transaction(() => {
      if (!this.#current(jobId, generation)) return;
      if (['aborted', 'error'].includes(message.stopReason)) {
        this.#archiveDraft(jobId, generation, 'interrupted');
        this.#set(jobId, 'needs_attention', 'provider ended without reliable final usage');
        return;
      }
      const hasTools = message.content.some((part) => part.type === 'toolCall');
      if (hasTools && this.readJob(jobId).role === 'main' && !this.store.db.prepare('SELECT 1 FROM runtime_usage WHERE job_id = ? AND generation = ?').get(jobId, generation)) {
        // Pi skips beforeToolCall for an invalid current call. A final Main
        // response still supplies usage and all local intents; accept/reject
        // them atomically here, so an all-invalid batch has explicit results.
        this.#commitBatch(jobId, generation, { turnKey: `main-final:${generation}`, assistantMessage: message, calls: message.content.filter((part) => part.type === 'toolCall') });
        if (!this.#current(jobId, generation)) return;
      }
      if (!hasTools) {
        const allowed = this.#account(jobId, generation, message);
        this.store.appendHistory(jobId, `assistant:${generation}`, message);
        this.#markDraftCommitted(jobId, generation);
        this.#set(jobId, this.#pendingChildren(jobId).length ? 'needs_attention' : allowed ? 'completed' : 'budget_exceeded', this.#pendingChildren(jobId).length ? 'unresolved child ownership' : null);
      } else {
        const usage = this.store.db.prepare('SELECT 1 FROM runtime_usage WHERE job_id = ? AND generation = ?').get(jobId, generation);
        const durable = message.content.filter((part) => part.type === 'toolCall').every((part) => {
          const matches = this.store.db.prepare('SELECT 1 FROM runtime_calls WHERE job_id = ? AND call_id = ?').all(jobId, part.id);
          return matches.length === 1;
        });
        if (!usage || !durable) { this.#set(jobId, 'needs_attention', 'batch authorization did not commit'); return; }
        const incomplete = this.store.findIncompleteTurns(jobId);
        this.#set(jobId, incomplete.length ? 'needs_attention' : this.#pendingChildren(jobId).length ? 'waiting_children' : 'ready', incomplete.length ? 'unresolved batch' : null);
      }
      this.state.finishGeneration(jobId, generation);
    }).immediate();
  }
  async runStep(jobId, streamFunction) {
    if (this.active.has(jobId)) throw new Error('job already active');
    const generation = this.store.db.transaction(() => {
      const job = this.readJob(jobId);
      if (job.lifecycle !== 'ready' || job.cancelRequested || this.store.findIncompleteTurns(jobId).length || this.#pendingChildren(jobId).length) throw new Error('job is not ready');
      if (this.#hasUnknownAttempt(jobId)) {
        this.#set(jobId, 'needs_attention', 'interrupted model attempt; usage unknown'); return null;
      }
      const root = this.store.db.prepare('SELECT max_steps FROM runtime_roots WHERE root_job_id = ?').get(job.rootJobId);
      const attempts = this.store.db.prepare(`SELECT COUNT(*) AS count FROM coordinator_attempts a JOIN runtime_job_state j ON j.job_id = a.job_id WHERE j.root_job_id = ?`).get(job.rootJobId).count;
      const ownAttempts = this.store.db.prepare('SELECT COUNT(*) AS count FROM coordinator_attempts WHERE job_id = ?').get(jobId).count;
      if (!this.state.canStartGeneration(jobId).allowed || attempts >= root.max_steps || ownAttempts >= job.maxSteps) {
        this.#set(jobId, 'budget_exceeded', 'model budget exhausted'); return null;
      }
      const gen = this.state.beginGeneration(jobId);
      this.store.db.prepare('INSERT INTO coordinator_attempts VALUES (?, ?)').run(jobId, gen);
      this.#set(jobId, 'generating');
      return gen;
    }).immediate();
    if (generation === null) return this.readJob(jobId);
    this.active.set(jobId, null);
    let session;
    try {
      const projection = recoverTranscript({ store: this.store, jobId, cwd: this.sessionOptions.cwd, sessionDir: this.sessionOptions.sessionDir });
      const role = this.readJob(jobId).role;
      const declarations = role === 'main' ? MAIN_TOOLS : this.tools;
      ({ session } = await createPiSession({ ...this.sessionOptions, role, sessionManager: projection.sessionManager,
        customTools: ROLE_TOOLS[role].map((name) => ({ ...declarations.find((tool) => tool.name === name), execute: (callId, _args, signal) => this.#executeCall(jobId, generation, callId, signal) })),
        commitAssistantTurn: (entry) => this.#commitBatch(jobId, generation, entry),
        onAssistantTurn: ({ message }) => this.#finish(jobId, generation, message),
      }));
      this.active.set(jobId, session);
      session.subscribe((event) => this.#observeDraft(jobId, generation, event));
      if (!this.#current(jobId, generation)) return this.readJob(jobId);
      session.agent.streamFunction = streamFunction;
      await session.agent.continue();
      if (this.#current(jobId, generation) && this.state.readJob(jobId).status === 'running') this.#set(jobId, 'needs_attention', 'turn ended without durable finish');
    } catch (error) {
      if (this.#current(jobId, generation)) this.#set(jobId, 'needs_attention', error.message);
      throw error;
    } finally { session?.dispose(); this.active.delete(jobId); }
    return this.readJob(jobId);
  }
  async recover(jobId) {
    if (this.active.has(jobId)) throw new Error('cannot recover active job');
    const job = this.readJob(jobId);
    if (['completed', 'failed', 'budget_exceeded', 'cancelled'].includes(job.lifecycle)) return job;
    if (job.role === 'main' && this.#pendingChildren(jobId).length) return this.scanChildren(jobId);
    if (job.lifecycle === 'needs_attention' && !job.cancelRequested && this.store.findIncompleteTurns(jobId).length === 0) return job;
    this.active.set(jobId, null);
    try {
      const generation = this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ? AND status = 'running'").run(jobId);
        // The missing usage row is durable evidence independent of lifecycle.
        // Fence and preserve its blocked decision in this same transaction so
        // a crash after recovery opens cannot erase model ambiguity.
        if (!job.cancelRequested && this.#hasUnknownAttempt(jobId)) {
          for (const draft of this.drafts(jobId).filter((draft) => draft.status === 'streaming')) this.#archiveDraft(jobId, draft.generation, 'interrupted');
          this.#set(jobId, 'needs_attention', 'interrupted model attempt; usage unknown');
          return null;
        }
        this.#set(jobId, 'tools');
        return this.state.readJob(jobId).generation;
      }).immediate();
      if (generation === null) return this.readJob(jobId);
      for (const turn of this.store.findIncompleteTurns(jobId)) {
        for (const call of turn.calls.filter((call) => call.status !== 'completed')) {
          const outcome = this.reconciler.reconcile({ jobId, turnKey: turn.turnKey, callId: call.callId, ledger: this.ledger, verifiedIdentity: this.verifiedIdentity });
          if (outcome.action === 'completed') continue;
          if (outcome.action === 'dispatch_same_request') {
            if (this.readJob(jobId).cancelRequested) {
              this.store.db.transaction(() => this.#notExecuted(jobId, turn, call, 'Cancelled with authoritative proof of no worker acceptance')).immediate();
            } else {
              try { await this.#executeCall(jobId, generation, call.callId, new AbortController().signal); }
              catch (error) {
                if (!['budget_exceeded', 'cancelled'].includes(this.readJob(jobId).lifecycle)) this.#set(jobId, 'needs_attention', error.message);
                return this.readJob(jobId);
              }
            }
            continue;
          }
          this.#set(jobId, outcome.action === 'observe' ? 'tools' : 'needs_attention', outcome.reason ?? outcome.action);
          return this.readJob(jobId);
        }
      }
      const latest = this.readJob(jobId);
      if (this.store.findIncompleteTurns(jobId).length) this.#set(jobId, 'needs_attention', 'unresolved batch after recovery');
      else if (job.lifecycle === 'generating' && !latest.cancelRequested) this.#set(jobId, 'needs_attention', 'interrupted model attempt; usage unknown');
      else if (latest.lifecycle !== 'budget_exceeded') {
        this.#set(jobId, latest.cancelRequested ? 'cancelled' : 'ready');
      }
      return this.readJob(jobId);
    } finally { this.active.delete(jobId); }
  }
  async cancel(jobId) {
    const active = this.active.get(jobId);
    this.store.db.transaction(() => {
      const job = this.readJob(jobId);
      if (['completed', 'failed', 'cancelled', 'budget_exceeded'].includes(job.lifecycle)) return;
      this.#archiveDraft(jobId, job.generation, 'cancelled');
      this.store.db.prepare('UPDATE coordinator_jobs SET cancel_requested = 1 WHERE job_id = ?').run(jobId);
      this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ?").run(jobId);
      this.#set(jobId, this.store.findIncompleteTurns(jobId).length || this.#pendingChildren(jobId).length ? 'needs_attention' : 'cancelled', 'cancellation requested');
      for (const row of this.#pendingChildren(jobId)) {
        const child = this.readJob(row.child_job_id);
        if (['completed', 'failed', 'cancelled', 'budget_exceeded'].includes(child.lifecycle)) continue;
        this.#archiveDraft(child.jobId, child.generation, 'cancelled');
        this.store.db.prepare('UPDATE coordinator_jobs SET cancel_requested = 1 WHERE job_id = ?').run(child.jobId);
        this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ?").run(child.jobId);
        this.#set(child.jobId, this.store.findIncompleteTurns(child.jobId).length ? 'needs_attention' : 'cancelled', 'parent cancellation requested');
      }
    }).immediate();
    for (const delegation of this.#pendingChildren(jobId)) await this.cancel(delegation.child_job_id);
    await active?.abort();
    // If a session is active, its late results cannot update host state. A later
    // recover() may import factual cached worker completion before cancellation.
    if (!this.active.has(jobId)) return this.recover(jobId);
    return this.readJob(jobId);
  }
}
