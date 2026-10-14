-- O2-KR3 follow-up (#86, acceptance BLOCK-1): the execution mode a call was
-- committed with must be the one dispatch rebuilds the request from. Before
-- this column, commit computed the effective mode (a device lock forces
-- diagnosis) but dispatch rebuilt from the session's mode, so a session that
-- predates the lock produced committed_request_hash_mismatch and blocked the
-- worker. The mode is frozen onto the call at commit time and read back at
-- send time. Existing rows are backfilled with the mode their hash was
-- computed with before the column existed.
ALTER TABLE runtime_calls ADD COLUMN execution_mode TEXT
  CHECK(execution_mode IS NULL OR execution_mode IN ('diagnosis','approved'));
UPDATE runtime_calls SET execution_mode = (
  SELECT CASE
    WHEN j.approved_action_id IS NOT NULL AND j.verify_command IS NULL THEN 'approved'
    ELSE s.execution_mode
  END
  FROM jobs j JOIN sessions s ON s.session_id = j.session_id
  WHERE j.job_id = runtime_calls.job_id
) WHERE execution_mode IS NULL;
