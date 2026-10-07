import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
export function openDatabase(
  path: string,
  migrations = new URL("../../../migrations/", import.meta.url),
) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = FULL");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY)",
  );
  for (const version of readdirSync(migrations)
    .filter((x) => x.endsWith(".sql"))
    .sort()) {
    if (
      !db
        .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
        .get(version)
    ) {
      db.transaction(() => {
        db.exec(readFileSync(new URL(version, migrations), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (?)").run(version);
      })();
    }
  }
  // Connectivity is never recovered from a persisted online flag.
  db.prepare("UPDATE workers SET online=0,reconciled=0").run();
  return db;
}
