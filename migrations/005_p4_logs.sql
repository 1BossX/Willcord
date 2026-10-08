-- P4 command output. Chunks arrive live or by log_fetch and are deduplicated by
-- (job, call, stream, seq). call_log_state records what the worker stored and
-- what this node chose to keep, so a gap or truncation is never silent.
CREATE TABLE call_logs (
  job_id TEXT NOT NULL, call_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
  seq INTEGER NOT NULL CHECK(seq>=0), offset INTEGER NOT NULL CHECK(offset>=0),
  data BLOB NOT NULL,
  PRIMARY KEY(job_id,call_id,stream,seq),
  FOREIGN KEY(job_id,call_id) REFERENCES runtime_calls(job_id,call_id) ON DELETE CASCADE
);
CREATE TABLE call_log_state (
  job_id TEXT NOT NULL, call_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
  chunks INTEGER, bytes_total INTEGER,
  worker_truncated INTEGER NOT NULL DEFAULT 0,
  main_truncated INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('streaming','complete','expired')),
  PRIMARY KEY(job_id,call_id,stream),
  FOREIGN KEY(job_id,call_id) REFERENCES runtime_calls(job_id,call_id) ON DELETE CASCADE
);
