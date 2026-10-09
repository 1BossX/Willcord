-- A delegated step can carry a verification command chosen by the Main Agent.
-- The main node runs it after the child's final answer; its exit code decides success.
ALTER TABLE jobs ADD COLUMN verify_command TEXT;
