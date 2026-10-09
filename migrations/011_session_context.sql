-- P6-D: the earlier exchanges of its session a job carries, fixed when it
-- first runs: {"job_ids":[...],"omitted":n}. NULL for jobs that never ran
-- and for jobs that ran before this migration (they carry none).
ALTER TABLE jobs ADD COLUMN context_json TEXT;

-- The job view shows the carried context, so a change to it is a job event.
DROP TRIGGER events_job_update;
CREATE TRIGGER events_job_update AFTER UPDATE ON jobs
WHEN OLD.state IS NOT NEW.state OR OLD.queue_seq IS NOT NEW.queue_seq OR OLD.cancel_requested IS NOT NEW.cancel_requested
  OR OLD.cancel_reason IS NOT NEW.cancel_reason OR OLD.end_reason IS NOT NEW.end_reason OR OLD.result_json IS NOT NEW.result_json
  OR OLD.started_at IS NOT NEW.started_at OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.wait_until IS NOT NEW.wait_until
  OR OLD.verify_command IS NOT NEW.verify_command OR OLD.context_json IS NOT NEW.context_json
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',NEW.job_id,NEW.session_id,NEW.job_id);
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',p.job_id,p.session_id,p.job_id FROM jobs p WHERE p.job_id=NEW.parent_job_id;
END;
