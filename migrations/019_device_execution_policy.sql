-- O2-KR3 follow-up (#86): an administrator can lock a whole device to
-- diagnosis. NULL leaves the device unrestricted; 'diagnosis' forces every
-- session and dispatched call of this worker into diagnosis mode, whatever the
-- session that asked for the work was created as.
ALTER TABLE enrollments ADD COLUMN execution_policy TEXT
  CHECK(execution_policy IS NULL OR execution_policy = 'diagnosis');
