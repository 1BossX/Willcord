-- P7: whether this node starts work. A restored backup, low disk or an
-- operator pauses it; while paused nothing new starts and nothing resumes,
-- but workers still register and reconcile so their ledgers can be checked.
CREATE TABLE dispatch_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  paused INTEGER NOT NULL CHECK(paused IN (0,1)),
  reason TEXT,
  note TEXT,
  since INTEGER,
  CHECK((paused=0 AND reason IS NULL) OR (paused=1 AND reason IS NOT NULL))
);
INSERT INTO dispatch_state VALUES (1,0,NULL,NULL,NULL);

CREATE TRIGGER events_dispatch_update AFTER UPDATE ON dispatch_state BEGIN
  INSERT INTO events(created_at,content_json,kind,entity_id) VALUES (CAST(unixepoch('subsec')*1000 AS INTEGER),'{}','dispatch','dispatch');
END;

-- Output chunks of long-finished jobs are removed by retention; the state row
-- stays and says when, so the gap is explained rather than silent.
ALTER TABLE call_log_state ADD COLUMN pruned_at INTEGER;
