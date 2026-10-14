import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Device alerts (#86): an anomaly or an authorization change on a device
 * becomes an event row with kind='alert', written in the same transaction as
 * the change that caused it. The feed materializes the stored payload, the
 * console shows it, and the main node log carries the same line. There is no
 * outbound webhook channel yet; operators watch the feed and the logs.
 */
export type AlertSeverity = "info" | "warn" | "error";

export type AlertInput = {
  type: string;
  severity: AlertSeverity;
  worker_id?: string | null;
  job_id?: string | null;
  message: string;
  detail?: Record<string, unknown>;
};

export function emitAlert(db: Database.Database, now: () => number, alert: AlertInput): string {
  const alertId = `alert-${randomUUID()}`;
  // The same anomaly on the same device inside 10 minutes is one alert, not a
  // stream — a flapping connection or repeated revoke attempts stay readable.
  if (alert.worker_id) {
    const dup = db
      .prepare("SELECT entity_id FROM events WHERE kind='alert' AND json_extract(content_json,'$.type')=? AND json_extract(content_json,'$.worker_id')=? AND created_at>? LIMIT 1")
      .get(alert.type, alert.worker_id, now() - 600_000) as { entity_id: string } | undefined;
    if (dup) return dup.entity_id;
  }
  db.prepare("INSERT INTO events(created_at,content_json,kind,entity_id,job_id) VALUES (?,?, 'alert', ?, ?)").run(
    now(),
    JSON.stringify({ ...alert, alert_id: alertId }),
    alertId,
    alert.job_id ?? null,
  );
  return alertId;
}

/** The newest alerts first, for the console's snapshot and the alert panel. */
export function recentAlerts(db: Database.Database, limit = 50) {
  return (db.prepare("SELECT event_id,created_at,content_json,entity_id FROM events WHERE kind='alert' ORDER BY event_id DESC LIMIT ?").all(limit) as any[]).map((row) => ({
    event_id: row.event_id,
    alert_id: row.entity_id,
    created_at: row.created_at,
    ...JSON.parse(row.content_json),
  }));
}
