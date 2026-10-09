import Database from "better-sqlite3";
import { chmodSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "./storage.js";

export type BackupSummary = {
  integrity: string;
  schema: string | null;
  /** Calls whose outcome this database does not hold yet. */
  unsettled_calls: number;
  /** Highest committed call sequence per job, summed: moves only forward. */
  call_seq_watermark: number;
  queue_seq_watermark: number;
  /** Parents waiting on children, and children still open. */
  waiting_parents: number;
  open_children: number;
  open_jobs: number;
  workers: number;
};

/** What a database file holds, checked read-only. */
export function inspect(file: string): BackupSummary {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const one = (sql: string) => db.prepare(sql).pluck().get() as number;
    return {
      integrity: (db.pragma("integrity_check") as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join("; "),
      schema: db.prepare("SELECT MAX(version) FROM schema_migrations").pluck().get() as string | null,
      unsettled_calls: one("SELECT COUNT(*) FROM runtime_calls WHERE status IN ('committed','dispatched','unknown')"),
      call_seq_watermark: one("SELECT COALESCE(SUM(m),0) FROM (SELECT MAX(call_seq) m FROM runtime_calls GROUP BY job_id)"),
      queue_seq_watermark: one("SELECT COALESCE(MAX(queue_seq),0) FROM jobs"),
      waiting_parents: one("SELECT COUNT(*) FROM jobs WHERE state='waiting_children'"),
      open_children: one("SELECT COUNT(*) FROM jobs WHERE parent_job_id IS NOT NULL AND state NOT IN ('succeeded','failed','cancelled')"),
      open_jobs: one("SELECT COUNT(*) FROM jobs WHERE state NOT IN ('succeeded','failed','cancelled')"),
      workers: one("SELECT COUNT(*) FROM workers"),
    };
  } finally { db.close(); }
}

/**
 * Online backup: SQLite's backup API copies a consistent snapshot while the
 * main node keeps writing. The copy is checked before it is reported good.
 */
export async function backup(dataDir: string, dest: string) {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  const db = new Database(join(dataDir, "main.sqlite"), { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    await db.backup(dest);
  } finally { db.close(); }
  chmodSync(dest, 0o600);
  const summary = inspect(dest);
  if (summary.integrity !== "ok") throw new Error(`backup failed integrity check: ${summary.integrity}`);
  return summary;
}

/**
 * Put a backup in place of the main database. Only with the main node stopped;
 * the restored node starts with dispatch paused, so nothing runs until every
 * worker ledger has been reconciled against the restored records.
 */
export function restore(dataDir: string, file: string, now = Date.now()) {
  if (existsSync(join(dataDir, "main.lock"))) throw new Error("main.lock exists: stop the main node first (or remove a stale lock after checking no main process runs)");
  const summary = inspect(file);
  if (summary.integrity !== "ok") throw new Error(`backup failed integrity check: ${summary.integrity}`);
  const target = join(dataDir, "main.sqlite");
  const aside = `${target}.replaced-${now}`;
  // The current database and its WAL move aside together; nothing is deleted.
  if (existsSync(target)) for (const suffix of ["", "-wal", "-shm"]) if (existsSync(target + suffix)) renameSync(target + suffix, aside + suffix);
  const source = new Database(file, { readonly: true, fileMustExist: true });
  try { source.prepare("VACUUM INTO ?").run(target); } finally { source.close(); }
  chmodSync(target, 0o600);
  // An older backup is migrated now, so the pause below is the first thing it records.
  const db = openDatabase(target);
  try {
    db.prepare("UPDATE dispatch_state SET paused=1,reason='restored',note=?,since=? WHERE id=1").run(`restored from ${file}`, now);
  } finally { db.close(); }
  return { ...summary, replaced: existsSync(aside) ? aside : null };
}
