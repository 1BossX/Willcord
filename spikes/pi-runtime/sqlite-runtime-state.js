import Database from 'better-sqlite3';

export class RuntimeStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeStateError';
  }
}

/** Durable job/root counters and parent-child waits for the P0 runtime seam. */
export class SqliteRuntimeStateStore {
  constructor(filename, { db } = {}) {
    this.ownsDatabase = !db;
    this.db = db ?? new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.#createSchema();
  }

  close() {
    if (this.ownsDatabase) this.db.close();
  }

  createJob({ jobId, rootJobId = jobId, parentJobId = null, maxTokens, maxSteps }) {
    this.#validateId(jobId, 'jobId');
    this.#validateId(rootJobId, 'rootJobId');
    this.#validateLimit(maxTokens, 'maxTokens');
    this.#validateLimit(maxSteps, 'maxSteps');
    if (parentJobId !== null) this.#validateId(parentJobId, 'parentJobId');

    return this.db.transaction(() => {
      if (rootJobId === jobId) {
        this.db.prepare(`
          INSERT INTO runtime_roots (root_job_id, max_tokens, max_steps)
          VALUES (?, ?, ?)
        `).run(jobId, maxTokens, maxSteps);
      } else if (!this.db.prepare('SELECT 1 FROM runtime_roots WHERE root_job_id = ?').get(rootJobId)) {
        throw new RuntimeStateError(`unknown root job: ${rootJobId}`);
      }
      this.db.prepare(`
        INSERT INTO runtime_job_state
          (job_id, root_job_id, parent_job_id, max_tokens, max_steps, status)
        VALUES (?, ?, ?, ?, ?, 'ready')
      `).run(jobId, rootJobId, parentJobId, maxTokens, maxSteps);
      if (parentJobId !== null) {
        const parent = this.#readJob(parentJobId);
        if (parent.rootJobId !== rootJobId) throw new RuntimeStateError('parent and child must share a root job');
      }
      return this.#readJob(jobId);
    }).immediate();
  }

  readJob(jobId) {
    return this.#readJob(jobId);
  }

  canStartGeneration(jobId) {
    const job = this.#readJob(jobId);
    const root = this.#readRoot(job.rootJobId);
    const reasons = [];
    if (job.status !== 'ready') reasons.push(`job_status:${job.status}`);
    if (job.steps >= job.maxSteps) reasons.push('job_step_budget');
    if (job.inputTokens + job.outputTokens >= job.maxTokens) reasons.push('job_token_budget');
    if (root.steps >= root.maxSteps) reasons.push('root_step_budget');
    if (root.inputTokens + root.outputTokens >= root.maxTokens) reasons.push('root_token_budget');
    return { allowed: reasons.length === 0, reasons };
  }

  beginGeneration(jobId) {
    return this.db.transaction(() => {
      const allowed = this.canStartGeneration(jobId);
      if (!allowed.allowed) throw new RuntimeStateError(`cannot start generation: ${allowed.reasons.join(',')}`);
      const generation = this.db.prepare(`
        UPDATE runtime_job_state SET generation = generation + 1, status = 'running'
        WHERE job_id = ? RETURNING generation
      `).get(jobId).generation;
      return generation;
    }).immediate();
  }

  finishGeneration(jobId, generation) {
    const result = this.db.prepare(`
      UPDATE runtime_job_state SET status = 'ready'
      WHERE job_id = ? AND generation = ? AND status = 'running'
    `).run(jobId, generation);
    return result.changes === 1;
  }

  /**
   * Commit actual assistant usage once per generation. Tool authorization is
   * denied if this response crossed either token ceiling; a reached step ceiling
   * still permits this response's tools but blocks the next model generation.
   */
  recordAssistantUsage(jobId, generation, { inputTokens, outputTokens }) {
    this.#validateLimit(inputTokens, 'inputTokens');
    this.#validateLimit(outputTokens, 'outputTokens');
    return this.db.transaction(() => {
      const job = this.#readJob(jobId);
      if (job.generation !== generation || job.status !== 'running') {
        throw new RuntimeStateError(`stale generation for job: ${jobId}/${generation}`);
      }
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO runtime_usage (job_id, generation, input_tokens, output_tokens)
        VALUES (?, ?, ?, ?)
      `).run(jobId, generation, inputTokens, outputTokens);
      if (inserted.changes !== 1) throw new RuntimeStateError(`usage already recorded for generation: ${jobId}/${generation}`);
      this.db.prepare(`
        UPDATE runtime_job_state
        SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, steps = steps + 1
        WHERE job_id = ?
      `).run(inputTokens, outputTokens, jobId);
      this.db.prepare(`
        UPDATE runtime_roots SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, steps = steps + 1
        WHERE root_job_id = ?
      `).run(inputTokens, outputTokens, job.rootJobId);
      const updated = this.#readJob(jobId);
      const root = this.#readRoot(job.rootJobId);
      const reasons = [];
      if (updated.inputTokens + updated.outputTokens > updated.maxTokens) reasons.push('job_token_budget');
      if (root.inputTokens + root.outputTokens > root.maxTokens) reasons.push('root_token_budget');
      if (updated.steps > updated.maxSteps) reasons.push('job_step_budget');
      if (root.steps > root.maxSteps) reasons.push('root_step_budget');
      const mayExecuteTools = reasons.length === 0;
      if (!mayExecuteTools) {
        this.db.prepare(`UPDATE runtime_job_state SET status = 'budget_exceeded' WHERE job_id = ?`).run(jobId);
      }
      return {
        mayExecuteTools,
        mayStartNextGeneration: mayExecuteTools
          && updated.steps < updated.maxSteps
          && root.steps < root.maxSteps
          && updated.inputTokens + updated.outputTokens < updated.maxTokens
          && root.inputTokens + root.outputTokens < root.maxTokens,
        reasons,
        job: this.#readJob(jobId),
        root,
      };
    }).immediate();
  }

  waitForChild(parentJobId, childJobId) {
    return this.db.transaction(() => {
      const parent = this.#readJob(parentJobId);
      const child = this.#readJob(childJobId);
      if (parent.status !== 'running') throw new RuntimeStateError('parent must be running before it can wait');
      if (child.parentJobId !== parentJobId || child.rootJobId !== parent.rootJobId) {
        throw new RuntimeStateError('child does not belong to this parent/root');
      }
      this.db.prepare(`
        UPDATE runtime_job_state SET status = 'waiting_children', waiting_child_id = ?
        WHERE job_id = ?
      `).run(childJobId, parentJobId);
      return this.#readJob(parentJobId);
    }).immediate();
  }

  resolveChildWait(parentJobId, childResult) {
    if (!childResult || typeof childResult !== 'object' || typeof childResult.jobId !== 'string') {
      throw new TypeError('childResult.jobId is required');
    }
    const resultJson = JSON.stringify(childResult);
    return this.db.transaction(() => {
      const parent = this.#readJob(parentJobId);
      if (parent.status !== 'waiting_children' || parent.waitingChildId !== childResult.jobId) return false;
      this.db.prepare(`
        UPDATE runtime_job_state
        SET status = 'ready', waiting_child_id = NULL, child_result_json = ?
        WHERE job_id = ?
      `).run(resultJson, parentJobId);
      return true;
    }).immediate();
  }

  #readJob(jobId) {
    const row = this.db.prepare(`
      SELECT job_id, root_job_id, parent_job_id, generation, status, max_tokens, max_steps,
             input_tokens, output_tokens, steps, waiting_child_id, child_result_json
      FROM runtime_job_state WHERE job_id = ?
    `).get(jobId);
    if (!row) throw new RuntimeStateError(`unknown job: ${jobId}`);
    return {
      jobId: row.job_id,
      rootJobId: row.root_job_id,
      parentJobId: row.parent_job_id,
      generation: row.generation,
      status: row.status,
      maxTokens: row.max_tokens,
      maxSteps: row.max_steps,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      steps: row.steps,
      waitingChildId: row.waiting_child_id,
      childResult: row.child_result_json === null ? null : JSON.parse(row.child_result_json),
    };
  }

  #readRoot(rootJobId) {
    const row = this.db.prepare(`
      SELECT root_job_id, max_tokens, max_steps, input_tokens, output_tokens, steps
      FROM runtime_roots WHERE root_job_id = ?
    `).get(rootJobId);
    if (!row) throw new RuntimeStateError(`unknown root job: ${rootJobId}`);
    return {
      rootJobId: row.root_job_id,
      maxTokens: row.max_tokens,
      maxSteps: row.max_steps,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      steps: row.steps,
    };
  }

  #validateId(value, field) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${field} is required`);
  }

  #validateLimit(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  }

  #createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_roots (
        root_job_id TEXT PRIMARY KEY,
        max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0),
        max_steps INTEGER NOT NULL CHECK (max_steps >= 0),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0)
      );
      CREATE TABLE IF NOT EXISTS runtime_job_state (
        job_id TEXT PRIMARY KEY,
        root_job_id TEXT NOT NULL REFERENCES runtime_roots(root_job_id),
        parent_job_id TEXT REFERENCES runtime_job_state(job_id),
        generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'running', 'waiting_children', 'budget_exceeded')),
        max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0),
        max_steps INTEGER NOT NULL CHECK (max_steps >= 0),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
        steps INTEGER NOT NULL DEFAULT 0 CHECK (steps >= 0),
        waiting_child_id TEXT REFERENCES runtime_job_state(job_id),
        child_result_json TEXT,
        CHECK ((status = 'waiting_children' AND waiting_child_id IS NOT NULL)
            OR (status != 'waiting_children' AND waiting_child_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS runtime_usage (
        job_id TEXT NOT NULL REFERENCES runtime_job_state(job_id),
        generation INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        PRIMARY KEY (job_id, generation)
      );
    `);
  }
}
