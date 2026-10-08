-- P4 control: cancel, budgets and operator resolution.
ALTER TABLE jobs ADD COLUMN cancel_reason TEXT;
ALTER TABLE jobs ADD COLUMN end_reason TEXT;
-- P5 shares a budget across delegated children; in P4 every job is its own root.
ALTER TABLE jobs ADD COLUMN root_job_id TEXT;
ALTER TABLE jobs ADD COLUMN max_tool_calls INTEGER;
ALTER TABLE jobs ADD COLUMN max_tokens INTEGER;
ALTER TABLE jobs ADD COLUMN max_runtime_secs INTEGER;
-- Set when the job first runs; a restart never moves it.
ALTER TABLE jobs ADD COLUMN deadline_at INTEGER;
UPDATE jobs SET root_job_id=job_id;
-- A ledger the worker reports that differs from the recorded one; adopted only by an operator.
ALTER TABLE workers ADD COLUMN reported_ledger_id TEXT;
-- Set by an operator unblock; cleared once the worker confirmed every resolve_call.
ALTER TABLE workers ADD COLUMN unblock_pending INTEGER NOT NULL DEFAULT 0;

-- runtime_calls gains not_executed (proven never run) and resolved (settled by an
-- operator). Its log tables reference it, so they are rebuilt with it.
ALTER TABLE runtime_calls RENAME TO runtime_calls_p3;
ALTER TABLE call_logs RENAME TO call_logs_p4;
ALTER TABLE call_log_state RENAME TO call_log_state_p4;
CREATE TABLE runtime_calls (
  job_id TEXT NOT NULL, turn_key TEXT NOT NULL, call_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL CHECK(call_seq>0), request_hash TEXT NOT NULL, tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('committed','dispatched','completed','unknown','not_executed','resolved')),
  result_json TEXT, completed_at INTEGER,
  cancel_sent_at INTEGER, resolution_json TEXT, resolve_acked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(job_id,call_id), UNIQUE(job_id,call_seq),
  FOREIGN KEY(job_id,turn_key) REFERENCES runtime_turns(job_id,turn_key) ON DELETE CASCADE
);
INSERT INTO runtime_calls(job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,status,result_json,completed_at)
  SELECT job_id,turn_key,call_id,call_seq,request_hash,tool_name,arguments_json,
    CASE WHEN status='completed' AND json_extract(result_json,'$.result.not_executed')=1 THEN 'not_executed' ELSE status END,
    result_json,completed_at FROM runtime_calls_p3;
CREATE TABLE call_logs (
  job_id TEXT NOT NULL, call_id TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
  seq INTEGER NOT NULL CHECK(seq>=0), offset INTEGER NOT NULL CHECK(offset>=0),
  data BLOB NOT NULL,
  PRIMARY KEY(job_id,call_id,stream,seq),
  FOREIGN KEY(job_id,call_id) REFERENCES runtime_calls(job_id,call_id) ON DELETE CASCADE
);
INSERT INTO call_logs SELECT * FROM call_logs_p4;
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
INSERT INTO call_log_state SELECT * FROM call_log_state_p4;
DROP TABLE call_logs_p4;
DROP TABLE call_log_state_p4;
DROP TABLE runtime_calls_p3;

-- Model usage per committed turn, written with the turn. usage_known=0 when an
-- aborted generation reported none.
CREATE TABLE job_usage (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  turn_key TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  usage_known INTEGER NOT NULL CHECK(usage_known IN (0,1)),
  PRIMARY KEY(job_id,turn_key)
);
CREATE TABLE budget_roots (
  root_job_id TEXT PRIMARY KEY,
  tokens_used INTEGER NOT NULL DEFAULT 0, tool_calls_used INTEGER NOT NULL DEFAULT 0
);
INSERT INTO budget_roots(root_job_id,tool_calls_used)
  SELECT j.job_id,(SELECT COUNT(*) FROM runtime_calls c WHERE c.job_id=j.job_id) FROM jobs j;
