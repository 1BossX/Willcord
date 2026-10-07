export const TOOL_ALLOWLISTS = Object.freeze({
  main: Object.freeze(['list_workers', 'delegate', 'get_job']),
  worker: Object.freeze(['read', 'write', 'bash']),
});

export class StaleGenerationError extends Error {
  constructor(jobId, generation) {
    super(`stale generation ${generation} for job ${jobId}`);
    this.name = 'StaleGenerationError';
  }
}

export class InMemoryCheckpointStore {
  #jobs = new Map();
  #events = [];

  createJob(jobId, initial = {}) {
    if (this.#jobs.has(jobId)) throw new Error(`job already exists: ${jobId}`);
    this.#jobs.set(jobId, {
      jobId,
      generation: 0,
      status: 'ready',
      messages: [],
      checkpoint: null,
      ...structuredClone(initial),
    });
  }

  readJob(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return structuredClone(job);
  }

  events() {
    return structuredClone(this.#events);
  }

  async beginGeneration(jobId) {
    const job = this.#require(jobId);
    job.generation += 1;
    job.status = 'running';
    this.#events.push({ type: 'generation_started', jobId, generation: job.generation });
    return job.generation;
  }

  async commitTurn(jobId, generation, assistantMessage, checkpoint) {
    const job = this.#require(jobId);
    if (job.generation !== generation || job.status !== 'running') return false;

    // One atomic write models the production transaction that stores the complete
    // assistant turn, every tool intent, and its resumable checkpoint together.
    job.messages.push(structuredClone(assistantMessage));
    job.checkpoint = structuredClone(checkpoint);
    job.status = 'turn_committed';
    this.#events.push({ type: 'turn_committed', jobId, generation, callIds: checkpoint.callIds });
    return true;
  }

  async markToolResult(jobId, generation, callId, result) {
    const job = this.#require(jobId);
    if (job.generation !== generation || job.status !== 'turn_committed') return false;
    const call = job.checkpoint.calls.find((item) => item.id === callId);
    if (!call) throw new Error(`call is not in committed checkpoint: ${callId}`);
    call.result = structuredClone(result);
    this.#events.push({ type: 'tool_result_committed', jobId, generation, callId });
    return true;
  }

  async setStatus(jobId, generation, status, data = {}) {
    const job = this.#require(jobId);
    if (job.generation !== generation) return false;
    job.status = status;
    Object.assign(job, structuredClone(data));
    this.#events.push({ type: 'status_changed', jobId, generation, status });
    return true;
  }

  async invalidateGeneration(jobId) {
    const job = this.#require(jobId);
    job.generation += 1;
    job.status = 'cancelled';
    this.#events.push({ type: 'generation_invalidated', jobId, generation: job.generation });
    return job.generation;
  }

  async completeChildWait(jobId, childResult) {
    const job = this.#require(jobId);
    if (job.status !== 'waiting_children' || job.waitingFor !== childResult.jobId) return false;
    job.messages.push({ role: 'tool', name: 'delegate', content: structuredClone(childResult) });
    job.childResult = structuredClone(childResult);
    job.waitingFor = null;
    job.status = 'ready';
    this.#events.push({ type: 'child_result_committed', jobId, generation: job.generation, childJobId: childResult.jobId });
    return true;
  }

  #require(jobId) {
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`unknown job: ${jobId}`);
    return job;
  }
}

/**
 * App-side orchestration harness. `model` stands in for Pi and must return one
 * complete assistant turn. `executeTool` is the only side-effect seam.
 */
export class RuntimeSeamHarness {
  constructor({ store, executeTool }) {
    this.store = store;
    this.executeTool = executeTool;
  }

  async advance({ jobId, role, model }) {
    const allowlist = TOOL_ALLOWLISTS[role];
    if (!allowlist) throw new Error(`unknown agent role: ${role}`);

    const generation = await this.store.beginGeneration(jobId);
    const turn = await model({ generation, history: this.store.readJob(jobId).messages });
    this.#assertCurrent(jobId, generation);
    this.#validateTurn(allowlist, turn);

    const calls = turn.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: structuredClone(call.arguments ?? {}),
    }));
    const committed = await this.store.commitTurn(jobId, generation, {
      role: 'assistant',
      content: turn.content ?? '',
      toolCalls: calls,
    }, {
      generation,
      callIds: calls.map((call) => call.id),
      calls: calls.map((call) => ({ ...call, status: 'pending' })),
    });
    if (!committed) throw new StaleGenerationError(jobId, generation);

    const results = [];
    // Deliberately await each tool before starting the next one.
    for (const call of calls) {
      this.#assertCurrent(jobId, generation);
      const snapshot = this.store.readJob(jobId);
      if (snapshot.status !== 'turn_committed' || !snapshot.checkpoint.calls.some((item) => item.id === call.id)) {
        throw new Error(`tool call is not authorized by a committed checkpoint: ${call.id}`);
      }
      const result = await this.executeTool({ jobId, generation, role, call });
      this.#assertCurrent(jobId, generation);
      const saved = await this.store.markToolResult(jobId, generation, call.id, result);
      if (!saved) throw new StaleGenerationError(jobId, generation);
      results.push({ callId: call.id, result });
      if (result?.kind === 'wait') {
        await this.store.setStatus(jobId, generation, 'waiting_children', {
          waitingFor: result.childJobId,
          completedCalls: results,
        });
        return { kind: 'waiting_children', generation, childJobId: result.childJobId };
      }
    }

    await this.store.setStatus(jobId, generation, 'ready', { completedCalls: results });
    return { kind: 'turn_completed', generation, results };
  }

  async resumeParent({ jobId, childResult, model }) {
    const job = this.store.readJob(jobId);
    if (job.status !== 'waiting_children') throw new Error(`job is not waiting for a child: ${jobId}`);
    if (job.waitingFor !== childResult.jobId) throw new Error('child result does not match parent wait');
    const saved = await this.store.completeChildWait(jobId, childResult);
    if (!saved) throw new Error('parent wait changed before child result was committed');
    return this.advance({ jobId, role: 'main', model });
  }

  async cancel(jobId) {
    return this.store.invalidateGeneration(jobId);
  }

  #assertCurrent(jobId, generation) {
    const job = this.store.readJob(jobId);
    if (job.generation !== generation || job.status === 'cancelled') {
      throw new StaleGenerationError(jobId, generation);
    }
  }

  #validateTurn(allowlist, turn) {
    if (!turn || !Array.isArray(turn.toolCalls)) throw new Error('model must return a complete turn with toolCalls');
    const ids = new Set();
    for (const call of turn.toolCalls) {
      if (!allowlist.includes(call.name)) throw new Error(`tool is not allowed for this role: ${call.name}`);
      if (typeof call.id !== 'string' || call.id.length === 0) throw new Error('tool call must have a stable non-empty id');
      if (ids.has(call.id)) throw new Error(`duplicate tool call id: ${call.id}`);
      ids.add(call.id);
    }
  }
}
