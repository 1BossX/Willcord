# Pi runtime seam harness

This spike contains both a deterministic application-side seam harness and tests against the pinned Pi coding-agent SDK. Tests use Pi's faux provider and a test-only key stored in a temporary directory; they make no external model requests. They do not prove compatibility with a real provider or production database.

Run from this directory with:

```sh
npm test
```

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

The store in the app-side harness remains in-memory and process-local. Its `commitTurn` represents the required atomic production transaction. P0 remains open: test real-provider cancellation, cumulative token/step enforcement, complete crash/restart recovery with a production persistence adapter, and whether application checkpointing remains consistent with Pi SessionManager writes across crash windows. Never treat Pi JSONL as the job ledger.
