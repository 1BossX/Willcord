# Pi runtime seam harness

This spike contains both a deterministic application-side seam harness and tests against the pinned Pi coding-agent SDK. Tests use Pi's faux provider and a test-only key stored in a temporary directory; they make no external model requests. They do not prove compatibility with a real provider or production database.

Run from this directory with:

```sh
npm test
```

The live provider cancellation check makes one billable request and requires an
OpenRouter key in `OPENROUTER_API_KEY`:

```sh
npm run verify:openrouter
```

It uses a temporary Pi credential store, aborts after the first real response
chunk, and removes the temporary directory when it exits. The final usage frame
is unavailable after cancellation, so the request's cancellation cost is not
known.

The app-side harness exercises these control-plane assumptions:

- Main and worker roles receive distinct tool allowlists; rejected tools cannot reach the executor.
- The complete assistant turn, every tool intent, and a checkpoint are committed before execution can begin.
- Multiple calls returned in one turn execute one at a time and in order.
- Invalidating a generation makes a late model response unable to commit tools or a terminal update.
- A parent enters `waiting_children` and stops advancing; a matching persisted child result resumes it.

The SDK tests additionally verify Pi 1.0.4:

- `noTools: "all"` plus explicit names exposes only the selected custom tool definitions.
- `Agent.beforeToolCall` receives the entire assistant tool-call batch and can durably checkpoint it before the first tool executes.
- The hook runs once per tool in a batch, so checkpoint commits must be idempotent by assistant turn key.
- Pi's SessionManager reloads assistant tool calls and their tool results from JSONL.
- `finishTurn: { action: "end" }` via the host hook returns control after one assistant response; the host explicitly starts the next model turn.
- An accepted delegate tool result with `terminate: true` ends the parent run until the host resumes it.
- `session.abort()` propagates an AbortSignal to the provider stream and settles the run when the provider honors it.

The app-side orchestration harness remains in-memory and process-local. Its `commitTurn` represents the required atomic production transaction. The separate SQLite spike adapters now cover call checkpoints, job/root budget counters, and durable parent-child waits, but they are not integrated into a production ExecutionCoordinator. P0 remains open: complete Pi/SQLite crash-window reconciliation, unresolved worker-ledger recovery, budget and wait integration, and proof that the two persistence stores remain consistent after crashes. Never treat Pi JSONL as the job ledger.

SQLite transcript recovery is available as `recoverTranscript` in
`transcript-recovery.js`. Record each user message with `appendHistory` before
passing it to Pi; record non-tool assistant replies (including cancellation)
with the same API. Entry keys are stable host IDs; the `turn:` prefix is reserved.
Tool batches use `persistTurn`, which adds their history entry in the same
transaction as every intent. Persist complete Pi `toolResult` messages through
`recordResult`, including call ID, tool name, content, error flag and timestamp.
Recovery validates identities and creates a fresh SessionManager projection;
create the AgentSession only after recovery succeeds. Old JSONL branches have
no execution authority. Automatic compaction is disabled in the Pi wrapper.

Any committed or dispatched call without a result throws `RecoveryBlockedError`
before a Pi session can continue. This PR neither dispatches pending calls nor
reconciles a worker ledger. Aborted assistant history is retained; Pi requires
a new durably recorded user prompt rather than `agent.continue()` from that
assistant. Legacy checkpoints missing ordered user/base history block explicitly
and require migration. The host still owns system prompt/configuration, tool
result capture, exclusive scheduling, and generation fencing; this spike is not
a production Coordinator.

Projection success grants no job execution authorization. Before starting a
model request, the Coordinator must check durable job lifecycle state; aborted,
cancelled or terminal jobs remain stopped until an explicit authorized lifecycle
transition. A new user message alone does not override that gate.

`worker-ledger.js` adds a separate SQLite worker ledger and host-side
`WorkerReconciler`. Persist `bind()` before any dispatch, supplying the target
validated by the host (worker/ledger/workspace/version), original session and
timeout. The binding is immutable and restart-safe. A checkpoint/binding gap
fails closed during reconciliation; an already dispatched call without its
original binding cannot acquire a new one. These APIs do not authenticate a
remote worker: verified identity must come from a trusted host connection layer.

`reconcile()` returns one explicit decision:

- `completed`: import the cached matching Pi result into the local checkpoint.
- `observe`: accepted/running in the same verified boot; continue observing.
- `wait`: an earlier serial call is unresolved.
- `dispatch_same_request`: the same verified ledger authoritatively has never
  accepted this ID/sequence above its retired floor. This is a decision, not an
  execution permit: call `ledger.accept()` in its immediate transaction before
  marking running/starting a side effect. It rechecks identity, deduplication,
  retained floor and the worker-wide unresolved slot.
- `needs_attention`: identity loss/change, unknown old-boot execution, missing
  binding, conflicting request/result or insufficient retained evidence.

Missing detail at/below the retained floor is unknown, never a fresh dispatch.
Retirement requires a host result commit/ack first, and retains per-call identity
and hash tombstones even after detailed results are deleted. Same-boot repeated
acceptance returns existing state; `start()` only consumes a fresh accepted
transition once. A new boot cannot restart an accepted/running record. Reconcile
never executes a tool or starts a model; incomplete history stays blocked by the
existing transcript recovery gate.

Request hash covers original job/turn/session/call/sequence, target workspace
identity/version, tool arguments and timeout. Its sorted-key `spike-json-v1`
algorithm is **provisional, not RFC 8785 conformant**; Rust/JS interoperability
and normative RFC fixtures are still production work. Process/data-directory
exclusive ownership, authenticated transport, lifecycle blocking persistence,
RPC dispatch, result acknowledgments and full Coordinator scheduling are also
not implemented by this spike.
