//! `worker-plane-worker debug [--json] config.toml`: read-only preflight for
//! installs. It never registers with the main node: a connection carrying a
//! valid token would replace a running worker's connection, so the network
//! check proves TLS and routing only, and the token is checked locally.
use crate::{
    Config, DEFAULT_LOG_DISK_BUDGET, DEFAULT_MIN_FREE_BYTES, Error, TokenSource, logs, validate,
};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    path::Path,
    time::Duration,
};
use tokio_tungstenite::{connect_async, tungstenite};

#[derive(Serialize, Debug)]
pub struct Check {
    pub name: &'static str,
    pub ok: bool,
    pub detail: String,
}

fn check(name: &'static str, outcome: Result<String, Error>) -> Check {
    match outcome {
        Ok(detail) => Check {
            name,
            ok: true,
            detail,
        },
        Err(error) => Check {
            name,
            ok: false,
            detail: error.to_string(),
        },
    }
}

/// Every check runs even when an earlier one fails, so one pass shows all problems.
pub async fn run(file: &str, json: bool) -> bool {
    let checks = match fs::read_to_string(file)
        .map_err(Error::from)
        .and_then(|text| toml::from_str::<Config>(&text).map_err(Error::from))
    {
        Ok(config) => checks(&config).await,
        Err(error) => vec![check("config", Err(error))],
    };
    let ok = checks.iter().all(|c| c.ok);
    if json {
        println!("{}", serde_json::json!({ "ok": ok, "checks": checks }));
    } else {
        for c in &checks {
            println!(
                "{} {:<10} {}",
                if c.ok { "ok  " } else { "FAIL" },
                c.name,
                c.detail
            );
        }
    }
    ok
}

pub async fn checks(config: &Config) -> Vec<Check> {
    vec![
        check(
            "config",
            validate(config).map(|()| format!("{} workspace(s)", config.workspaces.len())),
        ),
        check("token", token(config)),
        check("data_dir", data_dir(&config.data_dir)),
        check("ledger", ledger(&config.data_dir)),
        check("disk", disk(config)),
        check("tls", tls(&config.url).await),
    ]
}

fn token(config: &Config) -> Result<String, Error> {
    let source = TokenSource::new(
        config.token_file.clone(),
        std::env::var("WORKER_TOKEN").ok(),
    )?;
    source.read()?;
    Ok(match source {
        TokenSource::File(path) => format!(
            "token_file {} readable (not verified by the main node)",
            path.display()
        ),
        TokenSource::Env(_) => "WORKER_TOKEN set (not verified by the main node)".into(),
    })
}

/// Lock state without creating anything: a held lock means a worker is running here.
fn data_dir(dir: &Path) -> Result<String, Error> {
    if !dir.is_dir() {
        return Ok(format!(
            "{} does not exist yet; the worker creates it",
            dir.display()
        ));
    }
    use std::os::unix::fs::PermissionsExt;
    let mode = fs::metadata(dir)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(format!(
            "{} has mode {mode:o}; the worker sets 700 on start",
            dir.display()
        )
        .into());
    }
    let path = dir.join("worker.lock");
    if !path.exists() {
        return Ok("unlocked".into());
    }
    let lock = OpenOptions::new().read(true).write(true).open(path)?;
    Ok(match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock)?;
            "unlocked".into()
        }
        Err(_) => "locked by a running worker".into(),
    })
}

fn ledger(dir: &Path) -> Result<String, Error> {
    let path = dir.join("ledger.sqlite");
    if !path.exists() {
        return Ok("no ledger yet; the worker creates it".into());
    }
    let db = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let integrity: String = db.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(format!("integrity_check: {integrity}").into());
    }
    let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let worker_id: Option<String> = db
        .query_row("SELECT value FROM meta WHERE key='worker_id'", [], |r| {
            r.get(0)
        })
        .ok();
    Ok(format!(
        "integrity ok, schema v{version}, worker_id {}",
        worker_id.as_deref().unwrap_or("?")
    ))
}

fn disk(config: &Config) -> Result<String, Error> {
    let budget = config
        .log_disk_budget_bytes
        .unwrap_or(DEFAULT_LOG_DISK_BUDGET);
    let min_free = config.min_free_bytes.unwrap_or(DEFAULT_MIN_FREE_BYTES);
    let existing = config
        .data_dir
        .ancestors()
        .find(|p| p.exists())
        .ok_or("no existing ancestor")?;
    let free = logs::free_bytes(existing)?;
    let used = logs::usage(&config.data_dir.join("logs"));
    let detail = format!("free {free} B (min {min_free}), logs {used} B (budget {budget})");
    if free < min_free || used >= budget {
        return Err(format!("new calls would be refused: {detail}").into());
    }
    Ok(detail)
}

/// Handshake without a token. The main node answers 401 after TLS succeeds,
/// which proves the CA chain and the route without touching worker state.
async fn tls(url: &str) -> Result<String, Error> {
    let attempt = tokio::time::timeout(Duration::from_secs(10), connect_async(url)).await;
    match attempt.map_err(|_| "timed out after 10s")? {
        Err(tungstenite::Error::Http(response)) if response.status() == 401 => {
            Ok("certificate trusted; main node rejected the anonymous probe as expected".into())
        }
        Err(tungstenite::Error::Http(response)) => {
            Err(format!("unexpected HTTP {}", response.status()).into())
        }
        Err(error) => Err(error.into()),
        Ok(_) => Err("main node accepted a connection without a token".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::Ledger;
    use std::os::unix::fs::PermissionsExt;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("wp-debug-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn data_dir_reports_a_held_lock_and_loose_permissions() {
        let dir = temp();
        assert_eq!(data_dir(&dir).unwrap(), "unlocked");
        let held = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("worker.lock"))
            .unwrap();
        held.try_lock_exclusive().unwrap();
        assert_eq!(data_dir(&dir).unwrap(), "locked by a running worker");
        FileExt::unlock(&held).unwrap();
        assert_eq!(
            data_dir(&dir).unwrap(),
            "unlocked",
            "the probe released its own lock"
        );
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(data_dir(&dir).is_err());
        assert!(
            data_dir(&dir.join("missing"))
                .unwrap()
                .contains("does not exist")
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn ledger_is_checked_read_only() {
        let dir = temp();
        assert!(ledger(&dir).unwrap().contains("no ledger yet"));
        drop(Ledger::open(Connection::open(dir.join("ledger.sqlite")).unwrap(), "w-1").unwrap());
        let detail = ledger(&dir).unwrap();
        assert!(detail.starts_with("integrity ok"), "{detail}");
        fs::write(
            dir.join("ledger.sqlite"),
            b"not a database at all, just bytes",
        )
        .unwrap();
        assert!(ledger(&dir).is_err(), "a corrupt ledger fails the check");
        fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn an_unreachable_main_node_fails_the_tls_check() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        assert!(tls("wss://127.0.0.1:1/ws/worker").await.is_err());
    }
}
