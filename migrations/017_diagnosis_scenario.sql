-- O1-KR1: which of the three diagnosis scenarios a session is running.
ALTER TABLE sessions ADD COLUMN diagnosis_scenario TEXT
  CHECK(diagnosis_scenario IS NULL OR diagnosis_scenario IN ('docker-service','disk-usage','post-deploy'));
