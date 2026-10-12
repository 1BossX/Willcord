-- O2-KR1: diagnosis mode is fixed on the session for every job in it.
ALTER TABLE sessions ADD COLUMN execution_mode TEXT
  CHECK(execution_mode IS NULL OR execution_mode = 'diagnosis');
