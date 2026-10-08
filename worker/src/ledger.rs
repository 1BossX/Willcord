// Durable worker call ledger. A call is executed only after the ledger proves it
// was never accepted before; anything the ledger cannot prove stays blocked.
use crate::generated::CallReport;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type Error = Box<dyn std::error::Error + Send + Sync>;

const MAX_REPORTED_CALLS: usize = 128;
const SCHEMA_VERSION: i64 = 2;

#[derive(Clone, Debug, PartialEq)]
pub struct CallIdentity {
    pub job_id: String,
    pub call_id: String,
    pub call_seq: u64,
    pub request_hash: String,
}

#[derive(Debug, PartialEq)]
pub enum Accept {
    /// Newly accepted; the caller must mark it running before starting it.
    Execute,
    /// Already completed; carries the persisted `{ok, result}` record.
    Cached(Value),
    /// Accepted earlier by this boot and still executing.
    InProgress,
    /// Refused without execution; the reason is a protocol `tool_rejected` reason.
    Rejected(&'static str),
}

/// Stored output of one stream of a finished call.
#[derive(Clone, Debug, PartialEq)]
pub struct LogStream {
    pub stream: &'static str,
    pub chunks: u64,
}

pub struct Ledger {
    db: Connection,
    pub ledger_id: String,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Ledger {
    pub fn open(db: Connection, worker_id: &str) -> Result<Self, Error> {
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES ('ledger_id',?1)",
            [Uuid::new_v4().to_string()],
        )?;
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES ('worker_id',?1)",
            [worker_id],
        )?;
        let persisted: String =
            db.query_row("SELECT value FROM meta WHERE key='worker_id'", [], |r| {
                r.get(0)
            })?;
        if persisted != worker_id {
            return Err("worker_id conflicts with data directory".into());
        }
        let ledger_id = db.query_row("SELECT value FROM meta WHERE key='ledger_id'", [], |r| {
            r.get(0)
        })?;
        let mut ledger = Ledger { db, ledger_id };
        ledger.migrate()?;
        Ok(ledger)
    }

    fn migrate(&mut self) -> Result<(), Error> {
        let version: i64 = self.db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > SCHEMA_VERSION {
            return Err("ledger schema is newer than this worker".into());
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Exclusive)?;
        if version == 0 {
            Self::create_v1(&tx)?;
        }
        // v2 (P4): cancel requests, why a tombstone exists, and stored output.
        tx.execute_batch(
            "ALTER TABLE calls ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE tombstones ADD COLUMN reason TEXT NOT NULL DEFAULT 'retired'
               CHECK(reason IN ('retired','cancelled','resolved'));
             CREATE TABLE log_streams(call_id TEXT NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
               stream TEXT NOT NULL CHECK(stream IN ('stdout','stderr')),
               chunks INTEGER NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY(call_id,stream));",
        )?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    fn create_v1(tx: &rusqlite::Transaction) -> Result<(), Error> {
        let legacy: bool = tx
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='calls'",
                [],
                |r| r.get::<_, i64>(0),
            )?
            .eq(&1);
        if legacy {
            tx.execute_batch("ALTER TABLE calls RENAME TO calls_p2;")?;
        }
        tx.execute_batch(
            "CREATE TABLE calls(
               call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
               call_seq INTEGER NOT NULL CHECK(call_seq>=0), request_hash TEXT NOT NULL,
               boot_id TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','acked','unknown')),
               result_json TEXT, updated_at INTEGER NOT NULL,
               CHECK(status NOT IN ('completed','acked') OR result_json IS NOT NULL));
             CREATE UNIQUE INDEX calls_job_seq ON calls(job_id,call_seq) WHERE call_seq>0;
             CREATE TABLE job_floors(job_id TEXT PRIMARY KEY, acked_through INTEGER NOT NULL CHECK(acked_through>0));
             CREATE TABLE tombstones(call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, call_seq INTEGER NOT NULL,
               request_hash TEXT NOT NULL, retired_at INTEGER NOT NULL);",
        )?;
        if legacy {
            // P2 rows carry no call_seq or boot. Only acknowledged rows are provably
            // settled; every other legacy row stays unknown with its evidence kept.
            tx.execute(
                "INSERT INTO calls(call_id,job_id,call_seq,request_hash,boot_id,status,result_json,updated_at)
                 SELECT call_id,job_id,0,request_hash,'legacy',
                   CASE WHEN state='acked' AND result_json IS NOT NULL THEN 'acked' ELSE 'unknown' END,
                   result_json,?1 FROM calls_p2",
                [now_ms()],
            )?;
            tx.execute_batch("DROP TABLE calls_p2;")?;
        }
        Ok(())
    }

    /// A new process cannot observe calls started by an earlier boot.
    pub fn begin_boot(&self, boot_id: &str) -> Result<usize, Error> {
        Ok(self.db.execute(
            "UPDATE calls SET status='unknown',updated_at=?2 WHERE status IN ('accepted','running') AND boot_id<>?1",
            params![boot_id, now_ms()],
        )?)
    }

    /// `disk_ok` is consulted only for a call the ledger has never seen, so a
    /// full disk still answers duplicates from the ledger.
    pub fn accept(
        &mut self,
        call: &CallIdentity,
        boot_id: &str,
        disk_ok: bool,
    ) -> Result<Accept, Error> {
        if call.call_seq == 0 {
            return Ok(Accept::Rejected("conflict"));
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, u64, String, String, String, Option<String>)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash,status,boot_id,result_json FROM calls WHERE call_id=?1",
                [&call.call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        if let Some((job_id, call_seq, hash, status, accepted_boot, result)) = row {
            if job_id != call.job_id || call_seq != call.call_seq || hash != call.request_hash {
                return Ok(Accept::Rejected("conflict"));
            }
            return Ok(match status.as_str() {
                "completed" | "acked" => Accept::Cached(serde_json::from_str(
                    result.as_deref().ok_or("completed call without result")?,
                )?),
                "accepted" | "running" if accepted_boot == boot_id => Accept::InProgress,
                _ => Accept::Rejected("unknown"),
            });
        }
        let tombstone: Option<(String, u64, String, String)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash,reason FROM tombstones WHERE call_id=?1",
                [&call.call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((job_id, call_seq, hash, reason)) = tombstone {
            let same =
                job_id == call.job_id && call_seq == call.call_seq && hash == call.request_hash;
            return Ok(Accept::Rejected(match (same, reason.as_str()) {
                (false, _) => "conflict",
                (true, "cancelled") => "cancelled",
                (true, _) => "retired",
            }));
        }
        let sequence_taken: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM calls WHERE job_id=?1 AND call_seq=?2)
                 OR EXISTS(SELECT 1 FROM tombstones WHERE job_id=?1 AND call_seq=?2)",
            params![call.job_id, call.call_seq],
            |r| r.get(0),
        )?;
        if sequence_taken {
            return Ok(Accept::Rejected("conflict"));
        }
        let floor: u64 = tx
            .query_row(
                "SELECT acked_through FROM job_floors WHERE job_id=?1",
                [&call.job_id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if call.call_seq <= floor {
            return Ok(Accept::Rejected("retired"));
        }
        let blocking: Option<String> = tx
            .query_row(
                "SELECT status FROM calls WHERE status IN ('accepted','running','unknown') ORDER BY status='unknown' DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(status) = blocking {
            return Ok(Accept::Rejected(if status == "unknown" {
                "unknown"
            } else {
                "busy"
            }));
        }
        if !disk_ok {
            return Ok(Accept::Rejected("disk_full"));
        }
        tx.execute(
            "INSERT INTO calls(call_id,job_id,call_seq,request_hash,boot_id,status,updated_at) VALUES(?1,?2,?3,?4,?5,'accepted',?6)",
            params![call.call_id, call.job_id, call.call_seq, call.request_hash, boot_id, now_ms()],
        )?;
        tx.commit()?;
        Ok(Accept::Execute)
    }

    pub fn mark_running(&self, call_id: &str) -> Result<(), Error> {
        let changed = self.db.execute(
            "UPDATE calls SET status='running',updated_at=?2 WHERE call_id=?1 AND status='accepted'",
            params![call_id, now_ms()],
        )?;
        if changed != 1 {
            return Err("call is not accepted".into());
        }
        Ok(())
    }

    /// Persist the result together with the stored output it refers to.
    pub fn complete(
        &mut self,
        call_id: &str,
        record: &Value,
        logs: &[LogStream],
    ) -> Result<(), Error> {
        self.finish(call_id, "completed", record, logs)
    }

    /// Termination could not be confirmed: the call stays unknown with its
    /// evidence and blocks the worker like a crash would.
    pub fn mark_unknown(
        &mut self,
        call_id: &str,
        evidence: &Value,
        logs: &[LogStream],
    ) -> Result<(), Error> {
        self.finish(call_id, "unknown", evidence, logs)
    }

    fn finish(
        &mut self,
        call_id: &str,
        status: &str,
        record: &Value,
        logs: &[LogStream],
    ) -> Result<(), Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = tx.execute(
            "UPDATE calls SET status=?2,result_json=?3,updated_at=?4 WHERE call_id=?1 AND status='running'",
            params![call_id, status, record.to_string(), now_ms()],
        )?;
        if changed != 1 {
            return Err("call is not running".into());
        }
        for log in logs {
            tx.execute(
                "INSERT INTO log_streams(call_id,stream,chunks) VALUES(?1,?2,?3)",
                params![call_id, log.stream, log.chunks],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Record a stop request. A call this ledger never accepted is fenced with a
    /// tombstone in the same transaction, which proves it will never start.
    pub fn request_cancel(
        &mut self,
        call: &CallIdentity,
        boot_id: &str,
    ) -> Result<&'static str, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, u64, String, String, String)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash,status,boot_id FROM calls WHERE call_id=?1",
                [&call.call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()?;
        if let Some((job_id, call_seq, hash, status, accepted_boot)) = row {
            if job_id != call.job_id || call_seq != call.call_seq || hash != call.request_hash {
                return Ok("conflict");
            }
            let state = match status.as_str() {
                "completed" | "acked" => "completed",
                "accepted" | "running" if accepted_boot == boot_id => "running",
                _ => "unknown",
            };
            if state == "running" {
                tx.execute(
                    "UPDATE calls SET cancel_requested=1,updated_at=?2 WHERE call_id=?1",
                    params![call.call_id, now_ms()],
                )?;
                tx.commit()?;
            }
            return Ok(state);
        }
        let tombstone: Option<(String, u64, String, String)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash,reason FROM tombstones WHERE call_id=?1",
                [&call.call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        if let Some((job_id, call_seq, hash, reason)) = tombstone {
            if job_id != call.job_id || call_seq != call.call_seq || hash != call.request_hash {
                return Ok("conflict");
            }
            return Ok(match reason.as_str() {
                "cancelled" => "fenced",
                "resolved" => "unknown",
                _ => "completed",
            });
        }
        let sequence_taken: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM calls WHERE job_id=?1 AND call_seq=?2)
                 OR EXISTS(SELECT 1 FROM tombstones WHERE job_id=?1 AND call_seq=?2)",
            params![call.job_id, call.call_seq],
            |r| r.get(0),
        )?;
        if sequence_taken {
            return Ok("conflict");
        }
        tx.execute(
            "INSERT INTO tombstones(call_id,job_id,call_seq,request_hash,retired_at,reason) VALUES(?1,?2,?3,?4,?5,'cancelled')",
            params![call.call_id, call.job_id, call.call_seq, call.request_hash, now_ms()],
        )?;
        tx.commit()?;
        Ok("fenced")
    }

    /// An operator settled an unknown call. Its record becomes a tombstone so
    /// the call can never run, and the worker accepts new calls again.
    pub fn resolve(&mut self, call: &CallIdentity) -> Result<&'static str, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let unknown: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM calls WHERE call_id=?1 AND job_id=?2 AND call_seq=?3 AND request_hash=?4 AND status='unknown')",
            params![call.call_id, call.job_id, call.call_seq, call.request_hash],
            |r| r.get(0),
        )?;
        if !unknown {
            return Ok("not_unknown");
        }
        tx.execute(
            "INSERT INTO tombstones(call_id,job_id,call_seq,request_hash,retired_at,reason) VALUES(?1,?2,?3,?4,?5,'resolved')",
            params![call.call_id, call.job_id, call.call_seq, call.request_hash, now_ms()],
        )?;
        tx.execute("DELETE FROM calls WHERE call_id=?1", [&call.call_id])?;
        tx.commit()?;
        Ok("resolved")
    }

    /// Identity and status of a call still held in full.
    pub fn call(&self, call_id: &str) -> Result<Option<(CallIdentity, String)>, Error> {
        Ok(self
            .db
            .query_row(
                "SELECT job_id,call_id,call_seq,request_hash,status FROM calls WHERE call_id=?1",
                [call_id],
                |r| {
                    Ok((
                        CallIdentity {
                            job_id: r.get(0)?,
                            call_id: r.get(1)?,
                            call_seq: r.get(2)?,
                            request_hash: r.get(3)?,
                        },
                        r.get(4)?,
                    ))
                },
            )
            .optional()?)
    }

    /// The main node holds what it keeps of this stream.
    pub fn ack_log(&self, call_id: &str, stream: &str, chunks: u64) -> Result<(), Error> {
        self.db.execute(
            "UPDATE log_streams SET acked=1 WHERE call_id=?1 AND stream=?2 AND chunks<=?3",
            params![call_id, stream, chunks],
        )?;
        Ok(())
    }

    /// Calls whose stored output may be deleted: result and every stream acknowledged.
    pub fn settled_logs(&self) -> Result<Vec<String>, Error> {
        let mut statement = self.db.prepare(
            "SELECT call_id FROM calls c WHERE status='acked'
               AND EXISTS(SELECT 1 FROM log_streams l WHERE l.call_id=c.call_id)
               AND NOT EXISTS(SELECT 1 FROM log_streams l WHERE l.call_id=c.call_id AND acked=0)",
        )?;
        let ids = statement
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// Every call that may still own stored output.
    pub fn held_calls(&self) -> Result<Vec<String>, Error> {
        let mut statement = self.db.prepare("SELECT call_id FROM calls")?;
        let ids = statement
            .query_map([], |r| r.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    /// The main node committed this result and every earlier call of the job.
    pub fn acknowledge(
        &mut self,
        job_id: &str,
        call_id: &str,
        request_hash: &str,
        ack_through: u64,
    ) -> Result<(), Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(String, u64, String, String)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash,status FROM calls WHERE call_id=?1",
                [call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        match row {
            Some((job, seq, hash, status)) => {
                if job != job_id || hash != request_hash || ack_through > seq || seq == 0 {
                    return Err("tool ack identity mismatch".into());
                }
                if status != "completed" && status != "acked" {
                    return Err("tool ack before result".into());
                }
            }
            None => {
                let retired: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tombstones WHERE call_id=?1 AND job_id=?2 AND request_hash=?3 AND call_seq>=?4)",
                    params![call_id, job_id, request_hash, ack_through],
                    |r| r.get(0),
                )?;
                if !retired {
                    return Err("unknown tool ack".into());
                }
                return Ok(());
            }
        }
        let now = now_ms();
        tx.execute(
            "UPDATE calls SET status='acked',updated_at=?3 WHERE job_id=?1 AND call_seq BETWEEN 1 AND ?2 AND status='completed'",
            params![job_id, ack_through, now],
        )?;
        tx.execute(
            "INSERT INTO job_floors VALUES(?1,?2) ON CONFLICT(job_id) DO UPDATE SET acked_through=max(acked_through,excluded.acked_through)",
            params![job_id, ack_through],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Everything the main node still has to reconcile, in a bounded report.
    pub fn unacknowledged(&self) -> Result<Vec<CallReport>, Error> {
        let mut statement = self.db.prepare(
            "SELECT job_id,call_id,call_seq,request_hash,status,boot_id FROM calls WHERE status<>'acked' ORDER BY job_id,call_seq,call_id",
        )?;
        let reports = statement
            .query_map([], |r| {
                Ok(CallReport {
                    job_id: r.get(0)?,
                    call_id: r.get(1)?,
                    call_seq: r.get(2)?,
                    request_hash: r.get(3)?,
                    status: r.get(4)?,
                    boot_id: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if reports.len() > MAX_REPORTED_CALLS {
            return Err("unacknowledged ledger exceeds reconcile report bound".into());
        }
        Ok(reports)
    }

    /// Completed calls whose results may still be missing on the main node.
    pub fn completed_results(&self) -> Result<Vec<(CallIdentity, Value)>, Error> {
        let mut statement = self.db.prepare(
            "SELECT job_id,call_id,call_seq,request_hash,result_json FROM calls WHERE status='completed' ORDER BY job_id,call_seq",
        )?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    CallIdentity {
                        job_id: r.get(0)?,
                        call_id: r.get(1)?,
                        call_seq: r.get(2)?,
                        request_hash: r.get(3)?,
                    },
                    r.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(identity, result)| Ok((identity, serde_json::from_str(&result)?)))
            .collect()
    }

    pub fn completed_result(&self, call_id: &str) -> Result<Option<(CallIdentity, Value)>, Error> {
        Ok(self
            .completed_results()?
            .into_iter()
            .find(|(identity, _)| identity.call_id == call_id))
    }

    /// Drop detailed results of acknowledged calls but keep a tombstone, so an
    /// old frame can never revive the call.
    pub fn retire_acknowledged(&mut self, retention_ms: i64) -> Result<usize, Error> {
        let now = now_ms();
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO tombstones(call_id,job_id,call_seq,request_hash,retired_at,reason)
             SELECT call_id,job_id,call_seq,request_hash,?1,'retired' FROM calls WHERE status='acked' AND updated_at<=?2",
            params![now, now - retention_ms],
        )?;
        let removed = tx.execute(
            "DELETE FROM calls WHERE status='acked' AND updated_at<=?1",
            [now - retention_ms],
        )?;
        tx.commit()?;
        Ok(removed)
    }

    #[cfg(test)]
    pub fn status(&self, call_id: &str) -> Option<String> {
        self.db
            .query_row(
                "SELECT status FROM calls WHERE call_id=?1",
                [call_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(id: &str, seq: u64) -> CallIdentity {
        CallIdentity {
            job_id: "job-1".into(),
            call_id: id.into(),
            call_seq: seq,
            request_hash: format!("{:0>64}", seq),
        }
    }
    fn ledger() -> Ledger {
        Ledger::open(Connection::open_in_memory().unwrap(), "worker-a").unwrap()
    }
    fn finish(l: &mut Ledger, c: &CallIdentity) {
        assert_eq!(l.accept(c, "boot-1", true).unwrap(), Accept::Execute);
        l.mark_running(&c.call_id).unwrap();
        l.complete(
            &c.call_id,
            &json!({"ok":true,"result":{"n":c.call_seq}}),
            &[],
        )
        .unwrap();
    }

    #[test]
    fn ledger_identity_is_stable_and_bound_to_worker() {
        let dir = std::env::temp_dir().join(format!("ledger-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.sqlite");
        let first = Ledger::open(Connection::open(&path).unwrap(), "worker-a")
            .unwrap()
            .ledger_id;
        let second = Ledger::open(Connection::open(&path).unwrap(), "worker-a")
            .unwrap()
            .ledger_id;
        assert_eq!(first, second);
        assert!(Ledger::open(Connection::open(&path).unwrap(), "worker-b").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn duplicate_call_returns_cached_result_without_reexecution() {
        let mut l = ledger();
        let c = call("c1", 1);
        finish(&mut l, &c);
        assert_eq!(
            l.accept(&c, "boot-2", true).unwrap(),
            Accept::Cached(json!({"ok":true,"result":{"n":1}}))
        );
        let mut changed = c.clone();
        changed.request_hash = "f".repeat(64);
        assert_eq!(
            l.accept(&changed, "boot-1", true).unwrap(),
            Accept::Rejected("conflict")
        );
        assert_eq!(
            l.accept(&call("other", 1), "boot-1", true).unwrap(),
            Accept::Rejected("conflict")
        );
    }

    #[test]
    fn in_flight_call_is_observed_by_its_boot_and_unknown_after_restart() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1", true).unwrap(), Accept::Execute);
        assert_eq!(l.accept(&c, "boot-1", true).unwrap(), Accept::InProgress);
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", true).unwrap(),
            Accept::Rejected("busy")
        );
        l.mark_running("c1").unwrap();
        assert_eq!(l.begin_boot("boot-2").unwrap(), 1);
        assert_eq!(l.status("c1").as_deref(), Some("unknown"));
        assert_eq!(
            l.accept(&c, "boot-2", true).unwrap(),
            Accept::Rejected("unknown")
        );
        // Unknown execution blocks the whole worker.
        assert_eq!(
            l.accept(&call("c2", 2), "boot-2", true).unwrap(),
            Accept::Rejected("unknown")
        );
        assert_eq!(l.unacknowledged().unwrap()[0].status, "unknown");
    }

    #[test]
    fn acknowledgement_raises_floor_and_retired_calls_never_revive() {
        let mut l = ledger();
        let (c1, c2) = (call("c1", 1), call("c2", 2));
        finish(&mut l, &c1);
        finish(&mut l, &c2);
        assert!(l.acknowledge("job-1", "c2", &c2.request_hash, 3).is_err());
        l.acknowledge("job-1", "c2", &c2.request_hash, 2).unwrap();
        // ack_through covers the earlier completed call whose own ack was lost.
        assert_eq!(l.status("c1").as_deref(), Some("acked"));
        assert!(l.unacknowledged().unwrap().is_empty());
        assert_eq!(l.retire_acknowledged(0).unwrap(), 2);
        assert_eq!(
            l.accept(&c2, "boot-1", true).unwrap(),
            Accept::Rejected("retired")
        );
        // Reusing a retired sequence under another call ID is a conflict.
        let mut stale = call("c-old", 1);
        stale.job_id = "job-1".into();
        assert_eq!(
            l.accept(&stale, "boot-1", true).unwrap(),
            Accept::Rejected("conflict")
        );
        let mut below = call("c-new", 2);
        below.request_hash = "e".repeat(64);
        assert_eq!(
            l.accept(&below, "boot-1", true).unwrap(),
            Accept::Rejected("conflict")
        );
        // Repeated acks after retirement stay idempotent.
        l.acknowledge("job-1", "c2", &c2.request_hash, 2).unwrap();
        assert!(
            l.acknowledge("job-1", "missing", &c2.request_hash, 2)
                .is_err()
        );
        assert_eq!(
            l.accept(&call("c3", 3), "boot-1", true).unwrap(),
            Accept::Execute
        );
    }

    #[test]
    fn floor_rejects_unseen_old_sequence() {
        let mut l = ledger();
        let c3 = call("c3", 3);
        finish(&mut l, &c3);
        l.acknowledge("job-1", "c3", &c3.request_hash, 3).unwrap();
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", true).unwrap(),
            Accept::Rejected("retired")
        );
    }

    #[test]
    fn ack_requires_persisted_result() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1", true).unwrap(), Accept::Execute);
        assert!(l.acknowledge("job-1", "c1", &c.request_hash, 1).is_err());
        assert!(
            l.complete("c1", &json!({}), &[]).is_err(),
            "complete requires running"
        );
    }

    #[test]
    fn legacy_p2_ledger_migrates_fail_closed() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             INSERT INTO meta VALUES('ledger_id','ledger-p2'),('worker_id','worker-a');
             CREATE TABLE calls(call_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT);
             INSERT INTO calls VALUES('done','job-0','aa','acked','{\"ok\":true,\"result\":{}}');
             INSERT INTO calls VALUES('lost','job-0','bb','finished','{\"ok\":true,\"result\":{}}');
             INSERT INTO calls VALUES('mid','job-0','cc','running',NULL);",
        )
        .unwrap();
        let mut l = Ledger::open(db, "worker-a").unwrap();
        assert_eq!(l.ledger_id, "ledger-p2");
        assert_eq!(l.status("done").as_deref(), Some("acked"));
        assert_eq!(l.status("lost").as_deref(), Some("unknown"));
        assert_eq!(l.status("mid").as_deref(), Some("unknown"));
        let report = l.unacknowledged().unwrap();
        assert_eq!(report.len(), 2);
        assert!(
            report
                .iter()
                .all(|r| r.call_seq == 0 && r.status == "unknown")
        );
        assert_eq!(
            l.accept(&call("c1", 1), "boot-1", true).unwrap(),
            Accept::Rejected("unknown")
        );
    }

    #[test]
    fn cancel_fences_unseen_calls_and_marks_running_ones() {
        let mut l = ledger();
        let fenced = call("c1", 1);
        assert_eq!(l.request_cancel(&fenced, "boot-1").unwrap(), "fenced");
        assert_eq!(l.request_cancel(&fenced, "boot-1").unwrap(), "fenced");
        assert_eq!(
            l.accept(&fenced, "boot-1", true).unwrap(),
            Accept::Rejected("cancelled")
        );
        let mut forged = fenced.clone();
        forged.request_hash = "f".repeat(64);
        assert_eq!(l.request_cancel(&forged, "boot-1").unwrap(), "conflict");
        assert_eq!(
            l.accept(&forged, "boot-1", true).unwrap(),
            Accept::Rejected("conflict")
        );
        let running = call("c2", 2);
        assert_eq!(l.accept(&running, "boot-1", true).unwrap(), Accept::Execute);
        l.mark_running("c2").unwrap();
        assert_eq!(l.request_cancel(&running, "boot-1").unwrap(), "running");
        l.complete("c2", &json!({"ok":true,"result":{}}), &[])
            .unwrap();
        assert_eq!(l.request_cancel(&running, "boot-1").unwrap(), "completed");
        // A call from an earlier boot cannot be stopped by this process.
        let orphan = call("c3", 3);
        assert_eq!(l.accept(&orphan, "boot-1", true).unwrap(), Accept::Execute);
        l.begin_boot("boot-2").unwrap();
        assert_eq!(l.request_cancel(&orphan, "boot-2").unwrap(), "unknown");
    }

    #[test]
    fn full_disk_refuses_only_new_calls() {
        let mut l = ledger();
        let c = call("c1", 1);
        finish(&mut l, &c);
        assert!(matches!(
            l.accept(&c, "boot-1", false).unwrap(),
            Accept::Cached(_)
        ));
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", false).unwrap(),
            Accept::Rejected("disk_full")
        );
        assert_eq!(
            l.status("c2"),
            None,
            "nothing is recorded for a refused call"
        );
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", true).unwrap(),
            Accept::Execute
        );
    }

    #[test]
    fn resolving_unknown_unblocks_without_reviving_the_call() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1", true).unwrap(), Accept::Execute);
        l.mark_running("c1").unwrap();
        l.mark_unknown(
            "c1",
            &json!({"error":"termination_unconfirmed"}),
            &[LogStream {
                stream: "stdout",
                chunks: 1,
            }],
        )
        .unwrap();
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", true).unwrap(),
            Accept::Rejected("unknown")
        );
        let mut other = c.clone();
        other.request_hash = "f".repeat(64);
        assert_eq!(l.resolve(&other).unwrap(), "not_unknown");
        assert_eq!(l.resolve(&c).unwrap(), "resolved");
        assert_eq!(l.resolve(&c).unwrap(), "not_unknown");
        assert_eq!(
            l.accept(&c, "boot-1", true).unwrap(),
            Accept::Rejected("retired")
        );
        assert_eq!(l.request_cancel(&c, "boot-1").unwrap(), "unknown");
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1", true).unwrap(),
            Accept::Execute
        );
        assert!(!l.held_calls().unwrap().contains(&"c1".to_owned()));
    }

    #[test]
    fn logs_are_settled_only_after_result_and_every_stream_ack() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1", true).unwrap(), Accept::Execute);
        l.mark_running("c1").unwrap();
        let logs = [
            LogStream {
                stream: "stdout",
                chunks: 3,
            },
            LogStream {
                stream: "stderr",
                chunks: 0,
            },
        ];
        l.complete("c1", &json!({"ok":true,"result":{}}), &logs)
            .unwrap();
        l.ack_log("c1", "stdout", 3).unwrap();
        l.ack_log("c1", "stderr", 0).unwrap();
        assert!(
            l.settled_logs().unwrap().is_empty(),
            "result not yet acknowledged"
        );
        l.acknowledge("job-1", "c1", &c.request_hash, 1).unwrap();
        assert_eq!(l.settled_logs().unwrap(), vec!["c1".to_owned()]);
        let mut partial = ledger();
        assert_eq!(partial.accept(&c, "boot-1", true).unwrap(), Accept::Execute);
        partial.mark_running("c1").unwrap();
        partial
            .complete("c1", &json!({"ok":true,"result":{}}), &logs)
            .unwrap();
        partial
            .acknowledge("job-1", "c1", &c.request_hash, 1)
            .unwrap();
        partial.ack_log("c1", "stdout", 2).unwrap();
        assert!(
            partial.settled_logs().unwrap().is_empty(),
            "a short ack settles nothing"
        );
    }

    #[test]
    fn v1_ledger_upgrades_in_place() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
             INSERT INTO meta VALUES('ledger_id','ledger-v1'),('worker_id','worker-a');
             CREATE TABLE calls(call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL,
               call_seq INTEGER NOT NULL CHECK(call_seq>=0), request_hash TEXT NOT NULL,
               boot_id TEXT NOT NULL,
               status TEXT NOT NULL CHECK(status IN ('accepted','running','completed','acked','unknown')),
               result_json TEXT, updated_at INTEGER NOT NULL,
               CHECK(status NOT IN ('completed','acked') OR result_json IS NOT NULL));
             CREATE UNIQUE INDEX calls_job_seq ON calls(job_id,call_seq) WHERE call_seq>0;
             CREATE TABLE job_floors(job_id TEXT PRIMARY KEY, acked_through INTEGER NOT NULL CHECK(acked_through>0));
             CREATE TABLE tombstones(call_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, call_seq INTEGER NOT NULL,
               request_hash TEXT NOT NULL, retired_at INTEGER NOT NULL);
             INSERT INTO tombstones VALUES('old','job-1',1,'0000000000000000000000000000000000000000000000000000000000000001',1);
             INSERT INTO calls VALUES('live','job-1',2,'0000000000000000000000000000000000000000000000000000000000000002','b','completed','{\"ok\":true,\"result\":{}}',1);
             PRAGMA user_version=1;",
        )
        .unwrap();
        let mut l = Ledger::open(db, "worker-a").unwrap();
        assert_eq!(l.ledger_id, "ledger-v1");
        assert_eq!(
            l.accept(&call("old", 1), "boot-1", true).unwrap(),
            Accept::Rejected("retired")
        );
        assert!(matches!(
            l.accept(&call("live", 2), "boot-1", true).unwrap(),
            Accept::Cached(_)
        ));
        assert_eq!(
            l.request_cancel(&call("c3", 3), "boot-1").unwrap(),
            "fenced"
        );
    }
}
