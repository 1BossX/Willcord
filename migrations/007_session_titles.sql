ALTER TABLE sessions ADD COLUMN title TEXT
  CHECK(title IS NULL OR length(title) BETWEEN 1 AND 80);

UPDATE sessions
SET title = (
  SELECT substr(trim(j.input_text), 1, 80)
  FROM jobs j
  WHERE j.session_id = sessions.session_id
  ORDER BY j.queue_seq
  LIMIT 1
)
WHERE title IS NULL
  AND EXISTS (SELECT 1 FROM jobs j WHERE j.session_id = sessions.session_id);
