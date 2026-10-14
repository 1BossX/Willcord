import type Database from "better-sqlite3";

/**
 * The device-level execution policy (#86): a locked device only ever runs
 * diagnosis. Enforcement lives on the main node at three layers — session
 * creation, Main Agent delegation, and call dispatch — so no code path can
 * hand a writable call to a locked worker, and the worker keeps enforcing the
 * per-call mode it is sent.
 */
export type DeviceExecutionPolicy = "diagnosis" | null;

export function deviceExecutionPolicy(db: Database.Database, workerId: string | null | undefined): DeviceExecutionPolicy {
  if (!workerId) return null;
  const row = db.prepare("SELECT execution_policy FROM enrollments WHERE worker_id=?").get(workerId) as { execution_policy: string | null } | undefined;
  return row?.execution_policy === "diagnosis" ? "diagnosis" : null;
}

/**
 * The mode a dispatched call carries. A locked worker gets diagnosis on every
 * regular call, even in a session created before the policy was set.
 * Approved-mode calls keep their operator-approved binding; approving an
 * action for a locked worker is refused at the approval route.
 */
export function effectiveExecutionMode(
  db: Database.Database,
  workerId: string | null | undefined,
  sessionMode: string | null | undefined,
): "diagnosis" | "approved" | null {
  if (sessionMode === "approved") return "approved";
  if (deviceExecutionPolicy(db, workerId) === "diagnosis") return "diagnosis";
  return sessionMode === "diagnosis" ? "diagnosis" : null;
}

/** True when a proposed or requested session must be diagnosis on this worker. */
export const deviceRequiresDiagnosis = (db: Database.Database, workerId: string | null | undefined) =>
  deviceExecutionPolicy(db, workerId) === "diagnosis";
