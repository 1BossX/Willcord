-- P3: result commit time keeps rebuilt Pi transcripts identical across restarts.
ALTER TABLE runtime_calls ADD COLUMN completed_at INTEGER;
