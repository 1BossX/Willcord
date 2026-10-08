ALTER TABLE jobs ADD COLUMN input_text TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN wait_until INTEGER;
ALTER TABLE jobs ADD COLUMN runtime_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0;
CREATE TABLE runtime_turns (
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  turn_key TEXT NOT NULL, assistant_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  committed_at INTEGER NOT NULL, PRIMARY KEY(job_id,turn_key)
);
CREATE TABLE runtime_calls (
  job_id TEXT NOT NULL, turn_key TEXT NOT NULL, call_id TEXT NOT NULL,
  call_seq INTEGER NOT NULL CHECK(call_seq>0), request_hash TEXT NOT NULL, tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('committed','dispatched','completed','unknown')),
  result_json TEXT, PRIMARY KEY(job_id,call_id), UNIQUE(job_id,call_seq),
  FOREIGN KEY(job_id,turn_key) REFERENCES runtime_turns(job_id,turn_key) ON DELETE CASCADE
);
CREATE TABLE runtime_history (
  history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL, turn_key TEXT, message_json TEXT,
  UNIQUE(job_id,entry_key),
  CHECK((turn_key IS NULL AND message_json IS NOT NULL) OR (turn_key IS NOT NULL AND message_json IS NULL))
);
CREATE INDEX jobs_queue_order ON jobs(worker_id,queue_seq,state);
