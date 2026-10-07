CREATE TABLE worker_tokens (digest TEXT PRIMARY KEY, worker_id TEXT NOT NULL, revoked_at INTEGER);
CREATE TABLE auth_sessions (digest TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE administrators (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL);
CREATE TABLE workers (worker_id TEXT PRIMARY KEY, boot_id TEXT NOT NULL, ledger_id TEXT NOT NULL, connection_epoch INTEGER NOT NULL DEFAULT 0, online INTEGER NOT NULL DEFAULT 0, reconciled INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL);
CREATE TABLE workspaces (worker_id TEXT NOT NULL REFERENCES workers(worker_id), workspace_id TEXT NOT NULL, config_version INTEGER NOT NULL, path TEXT NOT NULL, repo_id TEXT NOT NULL, is_default INTEGER NOT NULL, PRIMARY KEY(worker_id,workspace_id));
CREATE UNIQUE INDEX one_default_workspace ON workspaces(worker_id) WHERE is_default=1;
CREATE TABLE worker_slots (worker_id TEXT PRIMARY KEY REFERENCES workers(worker_id), active_job_id TEXT);
