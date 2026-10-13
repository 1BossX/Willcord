-- O2-KR2: diagnosis → approve specific action → execute → verify.

CREATE TABLE approved_actions (
  approved_action_id TEXT PRIMARY KEY,
  diagnosis_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  worker_id TEXT NOT NULL REFERENCES workers(worker_id),
  tool TEXT NOT NULL CHECK(tool IN ('bash', 'write')),
  arguments_json TEXT NOT NULL,
  target TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  verify_command TEXT,
  state TEXT NOT NULL CHECK(state IN ('proposed', 'approved', 'executed', 'verified', 'rejected')),
  diagnosis_job_id TEXT REFERENCES jobs(job_id),
  execute_job_id TEXT REFERENCES jobs(job_id),
  verify_job_id TEXT REFERENCES jobs(job_id),
  proposed_at INTEGER NOT NULL,
  approved_at INTEGER,
  executed_at INTEGER,
  verified_at INTEGER,
  rejected_at INTEGER,
  reject_reason TEXT
);

CREATE INDEX idx_approved_actions_session ON approved_actions(diagnosis_session_id);
CREATE INDEX idx_approved_actions_worker ON approved_actions(worker_id);

CREATE TABLE approved_action_acceptance_passes (
  pass_number INTEGER PRIMARY KEY CHECK(pass_number BETWEEN 1 AND 10),
  approved_action_id TEXT NOT NULL REFERENCES approved_actions(approved_action_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('pass', 'fail')),
  record_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE jobs ADD COLUMN approved_action_id TEXT REFERENCES approved_actions(approved_action_id);
