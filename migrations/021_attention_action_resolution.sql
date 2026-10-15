-- #109: retry attention actions need a readable reason, plus an operator
-- resolution (handled / dismissed). Older rows keep their evidence as it was;
-- their reason is backfilled at read time from the jobs they point at, and
-- unexplainable ones are presented as legacy items an operator can dismiss.
ALTER TABLE attention_actions ADD COLUMN handled_at INTEGER;
ALTER TABLE attention_actions ADD COLUMN dismissed_at INTEGER;
