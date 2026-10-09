import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
export const MIGRATIONS = new URL("../../../migrations/", import.meta.url);
export function openDatabase(path: string, migrations = MIGRATIONS) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY)",
  );
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").pluck().all() as string[],
  );
  const pending = readdirSync(migrations)
    .filter((x) => x.endsWith(".sql") && !applied.has(x))
    .sort();
  // An upgrade keeps a copy of the database as it was, next to it, before
  // any migration runs. A fresh database has nothing to keep.
  if (pending.length && applied.size && path !== ":memory:") {
    const last = [...applied].sort().at(-1)!.replace(/\.sql$/, "");
    db.prepare("VACUUM INTO ?").run(
      join(dirname(path), `pre-migrate-${last}-${Date.now()}.sqlite`),
    );
  }
  for (const version of pending) {
    db.transaction(() => {
      db.exec(readFileSync(new URL(version, migrations), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?)").run(version);
    })();
  }
  // Connectivity is never recovered from a persisted online flag.
  db.prepare("UPDATE workers SET online=0,reconciled=0").run();
  return db;
}
