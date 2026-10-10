CREATE TABLE enrollments (
 worker_id TEXT PRIMARY KEY, public_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 os TEXT NOT NULL, arch TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','revoked')),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, pending_digest TEXT,
 confirmed_digest TEXT
);
CREATE TABLE enrollment_challenges (
 challenge TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
);
