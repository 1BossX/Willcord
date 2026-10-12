-- When a call was handed out and when it last produced output, so the console
-- can say how long it has run and how long it has been quiet. Both survive a
-- reload because they are stored, not inferred from when the browser saw events.
ALTER TABLE runtime_calls ADD COLUMN dispatched_at INTEGER;
ALTER TABLE call_log_state ADD COLUMN last_output_at INTEGER;
