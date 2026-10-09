-- P5 delegation: the Main Agent's child sessions, structured results and wait sets.
-- A child session belongs to the delegation that created it; it is never a user default.
ALTER TABLE sessions ADD COLUMN parent_job_id TEXT REFERENCES jobs(job_id);
ALTER TABLE sessions ADD COLUMN delegation_id TEXT;
-- Final structured result: outcome, summary, evidence call IDs, exit code, error, truncation.
ALTER TABLE jobs ADD COLUMN result_json TEXT;
-- The children a parent waits on before its next model turn, with the delegate call that created each.
CREATE TABLE job_waits (
  parent_job_id TEXT NOT NULL REFERENCES jobs(job_id),
  child_job_id TEXT NOT NULL REFERENCES jobs(job_id),
  call_id TEXT NOT NULL,
  PRIMARY KEY(parent_job_id,child_job_id)
);
CREATE INDEX jobs_parent ON jobs(parent_job_id);
CREATE INDEX job_dependencies_on ON job_dependencies(depends_on_job_id);
