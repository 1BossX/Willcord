import { createPiSession, ROLE_TOOLS } from './pi-runtime.js';
import { SqliteRuntimeStateStore } from './sqlite-runtime-state.js';
import { WorkerReconciler } from './worker-ledger.js';
import { recoverTranscript } from './transcript-recovery.js';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { isDeepStrictEqual } from 'node:util';

export function piUsage(message) {
  // Pi provider adapters separate uncached input from cache reads/writes.
  const usage = message.usage;
  const values = ['input', 'output', 'cacheRead', 'cacheWrite'].map((key) => usage?.[key]);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error('missing authoritative usage');
  const [input, output, cacheRead, cacheWrite] = values;
  return { inputTokens: input + cacheRead + cacheWrite, outputTokens: output };
}

/** Single-owner worker-role integration spike. Transport/identity is injected;
 * no remote authentication or parent/child orchestration is implemented here. */
export class ExecutionCoordinator {
  constructor({ store, ledger, verifiedIdentity, trustedTarget, sessionId, sessionOptions, tools, execute, timeoutMs = 1000 }) {
    this.store = store;
    this.state = new SqliteRuntimeStateStore(null, { db: store.db });
    this.reconciler = new WorkerReconciler(store);
    Object.assign(this, { ledger, verifiedIdentity, trustedTarget, sessionId, sessionOptions, tools, execute, timeoutMs });
    this.active = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS coordinator_jobs (
      job_id TEXT PRIMARY KEY REFERENCES runtime_job_state(job_id),
      status TEXT NOT NULL CHECK(status IN ('ready','generating','tools','completed','cancelled','needs_attention','budget_exceeded')),
      cancel_requested INTEGER NOT NULL DEFAULT 0, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS coordinator_attempts (
      job_id TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(job_id, generation)
    );`);
  }
  createJob({ jobId, rootJobId = jobId, maxTokens, maxSteps, prompt }) {
    this.store.db.transaction(() => {
      this.state.createJob({ jobId, rootJobId, maxTokens, maxSteps });
      this.store.db.prepare("INSERT INTO coordinator_jobs(job_id,status) VALUES (?, 'ready')").run(jobId);
      this.store.appendHistory(jobId, 'initial-user', { role: 'user', content: prompt, timestamp: Date.now() });
    }).immediate();
  }
  readJob(jobId) {
    const row = this.store.db.prepare('SELECT * FROM coordinator_jobs WHERE job_id = ?').get(jobId);
    if (!row) throw new Error('unknown coordinator job');
    return { ...this.state.readJob(jobId), lifecycle: row.status, cancelRequested: Boolean(row.cancel_requested), reason: row.reason };
  }
  #set(jobId, status, reason = null) {
    this.store.db.prepare('UPDATE coordinator_jobs SET status = ?, reason = ? WHERE job_id = ?').run(status, reason, jobId);
  }
  #current(jobId, generation) {
    const job = this.readJob(jobId);
    return job.generation === generation && !job.cancelRequested && ['generating', 'tools'].includes(job.lifecycle);
  }
  #hasUnknownAttempt(jobId) {
    return Boolean(this.store.db.prepare(`SELECT 1 FROM coordinator_attempts a
      LEFT JOIN runtime_usage u ON u.job_id = a.job_id AND u.generation = a.generation
      WHERE a.job_id = ? AND u.generation IS NULL LIMIT 1`).get(jobId));
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
      for (const call of entry.calls) this.reconciler.bind({ jobId, turnKey: entry.turnKey, callId: call.id,
        trustedTarget: this.trustedTarget, sessionId: this.sessionId, timeoutMs: this.timeoutMs });
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
  #findCall(jobId, callId) {
    const row = this.store.db.prepare('SELECT turn_key FROM runtime_calls WHERE job_id = ? AND call_id = ?').all(jobId, callId);
    if (row.length !== 1) throw new Error('ambiguous durable call');
    return row[0].turn_key;
  }
  async #executeCall(jobId, generation, callId, signal) {
    if (!this.#current(jobId, generation)) throw new Error('stale generation cannot execute');
    const turnKey = this.#findCall(jobId, callId);
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
        this.#set(jobId, 'needs_attention', 'provider ended without reliable final usage');
        return;
      }
      const hasTools = message.content.some((part) => part.type === 'toolCall');
      if (!hasTools) {
        const allowed = this.#account(jobId, generation, message);
        this.store.appendHistory(jobId, `assistant:${generation}`, message);
        this.#set(jobId, allowed ? 'completed' : 'budget_exceeded');
      } else {
        const usage = this.store.db.prepare('SELECT 1 FROM runtime_usage WHERE job_id = ? AND generation = ?').get(jobId, generation);
        const durable = message.content.filter((part) => part.type === 'toolCall').every((part) => {
          const matches = this.store.db.prepare('SELECT 1 FROM runtime_calls WHERE job_id = ? AND call_id = ?').all(jobId, part.id);
          return matches.length === 1;
        });
        if (!usage || !durable) { this.#set(jobId, 'needs_attention', 'batch authorization did not commit'); return; }
        const incomplete = this.store.findIncompleteTurns(jobId);
        this.#set(jobId, incomplete.length ? 'needs_attention' : 'ready', incomplete.length ? 'unresolved batch' : null);
      }
      this.state.finishGeneration(jobId, generation);
    }).immediate();
  }
  async runStep(jobId, streamFunction) {
    if (this.active.has(jobId)) throw new Error('job already active');
    const generation = this.store.db.transaction(() => {
      const job = this.readJob(jobId);
      if (job.lifecycle !== 'ready' || job.cancelRequested || this.store.findIncompleteTurns(jobId).length) throw new Error('job is not ready');
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
      ({ session } = await createPiSession({ ...this.sessionOptions, role: 'worker', sessionManager: projection.sessionManager,
        customTools: ROLE_TOOLS.worker.map((name) => ({ ...this.tools.find((tool) => tool.name === name), execute: (callId, _args, signal) => this.#executeCall(jobId, generation, callId, signal) })),
        commitAssistantTurn: (entry) => this.#commitBatch(jobId, generation, entry),
        onAssistantTurn: ({ message }) => this.#finish(jobId, generation, message),
      }));
      this.active.set(jobId, session);
      if (!this.#current(jobId, generation)) return this.readJob(jobId);
      session.agent.streamFunction = streamFunction;
      await session.agent.continue();
      if (this.#current(jobId, generation)) this.#set(jobId, 'needs_attention', 'turn ended without durable finish');
    } catch (error) {
      if (this.#current(jobId, generation)) this.#set(jobId, 'needs_attention', error.message);
      throw error;
    } finally { session?.dispose(); this.active.delete(jobId); }
    return this.readJob(jobId);
  }
  async recover(jobId) {
    if (this.active.has(jobId)) throw new Error('cannot recover active job');
    const job = this.readJob(jobId);
    if (['completed', 'budget_exceeded', 'cancelled'].includes(job.lifecycle)) return job;
    if (job.lifecycle === 'needs_attention' && !job.cancelRequested && this.store.findIncompleteTurns(jobId).length === 0) return job;
    this.active.set(jobId, null);
    try {
      const generation = this.store.db.transaction(() => {
        this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ? AND status = 'running'").run(jobId);
        // The missing usage row is durable evidence independent of lifecycle.
        // Fence and preserve its blocked decision in this same transaction so
        // a crash after recovery opens cannot erase model ambiguity.
        if (!job.cancelRequested && this.#hasUnknownAttempt(jobId)) {
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
      else if (latest.lifecycle !== 'budget_exceeded') this.#set(jobId, latest.cancelRequested ? 'cancelled' : 'ready');
      return this.readJob(jobId);
    } finally { this.active.delete(jobId); }
  }
  async cancel(jobId) {
    const active = this.active.get(jobId);
    this.store.db.transaction(() => {
      const job = this.readJob(jobId);
      if (['completed', 'cancelled'].includes(job.lifecycle)) return;
      this.store.db.prepare('UPDATE coordinator_jobs SET cancel_requested = 1 WHERE job_id = ?').run(jobId);
      this.store.db.prepare("UPDATE runtime_job_state SET generation = generation + 1, status = 'ready' WHERE job_id = ?").run(jobId);
      this.#set(jobId, this.store.findIncompleteTurns(jobId).length ? 'needs_attention' : 'cancelled', 'cancellation requested');
    }).immediate();
    await active?.abort();
    // If a session is active, its late results cannot update host state. A later
    // recover() may import factual cached worker completion before cancellation.
    if (!this.active.has(jobId)) return this.recover(jobId);
    return this.readJob(jobId);
  }
}
