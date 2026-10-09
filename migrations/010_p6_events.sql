-- P6 event feed. Every change the UI shows writes an event row in the same
-- transaction, through triggers, so no code path can change state without one.
-- An event names what changed (kind + entity); the feed sends that entity's
-- current state, so a replay or a repeat is idempotent.
ALTER TABLE events ADD COLUMN kind TEXT;
ALTER TABLE events ADD COLUMN entity_id TEXT;
ALTER TABLE events ADD COLUMN session_id TEXT;
ALTER TABLE events ADD COLUMN job_id TEXT;
CREATE INDEX events_created ON events(created_at);
-- The highest event ID removed by retention; a cursor at or below it has expired.
CREATE TABLE event_floor (id INTEGER PRIMARY KEY CHECK(id=1), floor INTEGER NOT NULL);
INSERT INTO event_floor VALUES (1, COALESCE((SELECT MAX(event_id) FROM events), 0));

-- Text of a model generation while it streams. It becomes committed with the
-- turn that carries it, or interrupted when the generation ends without one.
CREATE TABLE model_drafts (
  draft_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  text TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('streaming','committed','interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX model_drafts_session ON model_drafts(session_id, state);

-- jobs: the job, its parent (whose view lists its children) and, when the
-- queue moves, every job still waiting on that worker and the worker itself.
CREATE TRIGGER events_job_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',NEW.job_id,NEW.session_id,NEW.job_id);
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',p.job_id,p.session_id,p.job_id FROM jobs p WHERE p.job_id=NEW.parent_job_id;
  INSERT INTO events(created_at,content_json,kind,entity_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','worker',NEW.worker_id WHERE NEW.worker_id IS NOT NULL;
END;
CREATE TRIGGER events_job_update AFTER UPDATE ON jobs
WHEN OLD.state IS NOT NEW.state OR OLD.queue_seq IS NOT NEW.queue_seq OR OLD.cancel_requested IS NOT NEW.cancel_requested
  OR OLD.cancel_reason IS NOT NEW.cancel_reason OR OLD.end_reason IS NOT NEW.end_reason OR OLD.result_json IS NOT NEW.result_json
  OR OLD.started_at IS NOT NEW.started_at OR OLD.deadline_at IS NOT NEW.deadline_at OR OLD.wait_until IS NOT NEW.wait_until
  OR OLD.verify_command IS NOT NEW.verify_command
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',NEW.job_id,NEW.session_id,NEW.job_id);
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',p.job_id,p.session_id,p.job_id FROM jobs p WHERE p.job_id=NEW.parent_job_id;
END;
CREATE TRIGGER events_job_queue AFTER UPDATE OF state,queue_seq ON jobs
WHEN NEW.worker_id IS NOT NULL AND (OLD.queue_seq IS NOT NEW.queue_seq
  OR (OLD.state IN ('queued','waiting_worker')) <> (NEW.state IN ('queued','waiting_worker')))
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',q.job_id,q.session_id,q.job_id FROM jobs q
    WHERE q.worker_id=NEW.worker_id AND q.job_id<>NEW.job_id AND q.state IN ('queued','waiting_worker') AND q.queue_seq IS NOT NULL;
  INSERT INTO events(created_at,content_json,kind,entity_id) VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','worker',NEW.worker_id);
END;
-- Budget use is shown on every job of the root.
CREATE TRIGGER events_budget AFTER UPDATE ON budget_roots
WHEN OLD.tokens_used IS NOT NEW.tokens_used OR OLD.tool_calls_used IS NOT NEW.tool_calls_used
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','job',j.job_id,j.session_id,j.job_id FROM jobs j WHERE j.root_job_id=NEW.root_job_id;
END;

CREATE TRIGGER events_message AFTER INSERT ON messages BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','message',NEW.message_id,NEW.session_id,NEW.job_id);
END;

CREATE TRIGGER events_session_insert AFTER INSERT ON sessions BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','session',NEW.session_id,NEW.session_id);
END;
CREATE TRIGGER events_session_update AFTER UPDATE ON sessions WHEN OLD.title IS NOT NEW.title BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','session',NEW.session_id,NEW.session_id);
END;

CREATE TRIGGER events_worker_insert AFTER INSERT ON workers BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id) VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','worker',NEW.worker_id);
END;
-- Heartbeats (last_seen) are not events.
CREATE TRIGGER events_worker_update AFTER UPDATE ON workers
WHEN OLD.online IS NOT NEW.online OR OLD.reconciled IS NOT NEW.reconciled OR OLD.blocked IS NOT NEW.blocked
  OR OLD.unblock_pending IS NOT NEW.unblock_pending OR OLD.connection_epoch IS NOT NEW.connection_epoch
  OR OLD.reported_ledger_id IS NOT NEW.reported_ledger_id
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id) VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','worker',NEW.worker_id);
END;
CREATE TRIGGER events_slot AFTER UPDATE OF active_job_id ON worker_slots WHEN OLD.active_job_id IS NOT NEW.active_job_id BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id) VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','worker',NEW.worker_id);
END;

CREATE TRIGGER events_call_insert AFTER INSERT ON runtime_calls BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','call',NEW.call_id,j.session_id,NEW.job_id FROM jobs j WHERE j.job_id=NEW.job_id;
END;
CREATE TRIGGER events_call_update AFTER UPDATE ON runtime_calls
WHEN OLD.status IS NOT NEW.status OR OLD.cancel_sent_at IS NOT NEW.cancel_sent_at OR OLD.resolve_acked IS NOT NEW.resolve_acked
BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','call',NEW.call_id,j.session_id,NEW.job_id FROM jobs j WHERE j.job_id=NEW.job_id;
END;

-- Logs: the entity is call_id/stream; the event carries counts, never bytes.
CREATE TRIGGER events_log_state_insert AFTER INSERT ON call_log_state BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','log',NEW.call_id||'/'||NEW.stream,j.session_id,NEW.job_id FROM jobs j WHERE j.job_id=NEW.job_id;
END;
CREATE TRIGGER events_log_state_update AFTER UPDATE ON call_log_state BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','log',NEW.call_id||'/'||NEW.stream,j.session_id,NEW.job_id FROM jobs j WHERE j.job_id=NEW.job_id;
END;
CREATE TRIGGER events_log_chunk AFTER INSERT ON call_logs BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    SELECT CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','log',NEW.call_id||'/'||NEW.stream,j.session_id,NEW.job_id FROM jobs j WHERE j.job_id=NEW.job_id;
END;

CREATE TRIGGER events_draft_insert AFTER INSERT ON model_drafts BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','draft',NEW.draft_id,NEW.session_id,NEW.job_id);
END;
CREATE TRIGGER events_draft_update AFTER UPDATE ON model_drafts BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,session_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','draft',NEW.draft_id,NEW.session_id,NEW.job_id);
END;

CREATE TRIGGER events_attention AFTER INSERT ON attention_actions BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id,job_id)
    VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','attention',NEW.action_id,NEW.job_id);
END;
