// Durable worker call ledger. A call is executed only after the ledger proves it
// was never accepted before; anything the ledger cannot prove stays blocked.
use crate::generated::CallReport;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

type Error = Box<dyn std::error::Error + Send + Sync>;

const MAX_REPORTED_CALLS: usize = 128;
const SCHEMA_VERSION: i64 = 1;

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
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        tx.commit()?;
        Ok(())
    }

    /// A new process cannot observe calls started by an earlier boot.
    pub fn begin_boot(&self, boot_id: &str) -> Result<usize, Error> {
        Ok(self.db.execute(
            "UPDATE calls SET status='unknown',updated_at=?2 WHERE status IN ('accepted','running') AND boot_id<>?1",
            params![boot_id, now_ms()],
        )?)
    }

    pub fn accept(&mut self, call: &CallIdentity, boot_id: &str) -> Result<Accept, Error> {
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
        let tombstone: Option<(String, u64, String)> = tx
            .query_row(
                "SELECT job_id,call_seq,request_hash FROM tombstones WHERE call_id=?1",
                [&call.call_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((job_id, call_seq, hash)) = tombstone {
            let same =
                job_id == call.job_id && call_seq == call.call_seq && hash == call.request_hash;
            return Ok(Accept::Rejected(if same { "retired" } else { "conflict" }));
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

    pub fn complete(&self, call_id: &str, record: &Value) -> Result<(), Error> {
        let changed = self.db.execute(
            "UPDATE calls SET status='completed',result_json=?2,updated_at=?3 WHERE call_id=?1 AND status='running'",
            params![call_id, record.to_string(), now_ms()],
        )?;
        if changed != 1 {
            return Err("call is not running".into());
        }
        Ok(())
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
            "INSERT INTO tombstones(call_id,job_id,call_seq,request_hash,retired_at)
             SELECT call_id,job_id,call_seq,request_hash,?1 FROM calls WHERE status='acked' AND updated_at<=?2",
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
        assert_eq!(l.accept(c, "boot-1").unwrap(), Accept::Execute);
        l.mark_running(&c.call_id).unwrap();
        l.complete(&c.call_id, &json!({"ok":true,"result":{"n":c.call_seq}}))
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
            l.accept(&c, "boot-2").unwrap(),
            Accept::Cached(json!({"ok":true,"result":{"n":1}}))
        );
        let mut changed = c.clone();
        changed.request_hash = "f".repeat(64);
        assert_eq!(
            l.accept(&changed, "boot-1").unwrap(),
            Accept::Rejected("conflict")
        );
        assert_eq!(
            l.accept(&call("other", 1), "boot-1").unwrap(),
            Accept::Rejected("conflict")
        );
    }

    #[test]
    fn in_flight_call_is_observed_by_its_boot_and_unknown_after_restart() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1").unwrap(), Accept::Execute);
        assert_eq!(l.accept(&c, "boot-1").unwrap(), Accept::InProgress);
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1").unwrap(),
            Accept::Rejected("busy")
        );
        l.mark_running("c1").unwrap();
        assert_eq!(l.begin_boot("boot-2").unwrap(), 1);
        assert_eq!(l.status("c1").as_deref(), Some("unknown"));
        assert_eq!(l.accept(&c, "boot-2").unwrap(), Accept::Rejected("unknown"));
        // Unknown execution blocks the whole worker.
        assert_eq!(
            l.accept(&call("c2", 2), "boot-2").unwrap(),
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
            l.accept(&c2, "boot-1").unwrap(),
            Accept::Rejected("retired")
        );
        // Reusing a retired sequence under another call ID is a conflict.
        let mut stale = call("c-old", 1);
        stale.job_id = "job-1".into();
        assert_eq!(
            l.accept(&stale, "boot-1").unwrap(),
            Accept::Rejected("conflict")
        );
        let mut below = call("c-new", 2);
        below.request_hash = "e".repeat(64);
        assert_eq!(
            l.accept(&below, "boot-1").unwrap(),
            Accept::Rejected("conflict")
        );
        // Repeated acks after retirement stay idempotent.
        l.acknowledge("job-1", "c2", &c2.request_hash, 2).unwrap();
        assert!(
            l.acknowledge("job-1", "missing", &c2.request_hash, 2)
                .is_err()
        );
        assert_eq!(l.accept(&call("c3", 3), "boot-1").unwrap(), Accept::Execute);
    }

    #[test]
    fn floor_rejects_unseen_old_sequence() {
        let mut l = ledger();
        let c3 = call("c3", 3);
        finish(&mut l, &c3);
        l.acknowledge("job-1", "c3", &c3.request_hash, 3).unwrap();
        assert_eq!(
            l.accept(&call("c2", 2), "boot-1").unwrap(),
            Accept::Rejected("retired")
        );
    }

    #[test]
    fn ack_requires_persisted_result() {
        let mut l = ledger();
        let c = call("c1", 1);
        assert_eq!(l.accept(&c, "boot-1").unwrap(), Accept::Execute);
        assert!(l.acknowledge("job-1", "c1", &c.request_hash, 1).is_err());
        assert!(
            l.complete("c1", &json!({})).is_err(),
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
            l.accept(&call("c1", 1), "boot-1").unwrap(),
            Accept::Rejected("unknown")
        );
    }
}
