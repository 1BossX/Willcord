#[allow(dead_code)]
mod generated;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    time::Duration,
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    worker_id: String,
    data_dir: PathBuf,
    url: String,
    workspaces: Vec<generated::Workspace>,
}
fn identity(db: &Connection) -> rusqlite::Result<String> {
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
    db.execute(
        "INSERT OR IGNORE INTO meta VALUES ('ledger_id',?1)",
        [Uuid::new_v4().to_string()],
    )?;
    db.query_row("SELECT value FROM meta WHERE key='ledger_id'", [], |r| {
        r.get(0)
    })
}
fn parse_frame(text: &str) -> Result<Value, Box<dyn std::error::Error>> {
    if text.len() > 65536 {
        return Err("oversized frame".into());
    }
    let value: Value = serde_json::from_str(text)?;
    let schema: Value = serde_json::from_str(include_str!("../../packages/protocol/schema.json"))?;
    if !jsonschema::validator_for(&schema)?.is_valid(&value) {
        return Err("invalid frame".into());
    }
    Ok(value)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "TLS crypto provider unavailable")?;
    let file = std::env::args()
        .nth(1)
        .ok_or("usage: worker-plane-worker config.toml")?;
    let config: Config = toml::from_str(&fs::read_to_string(file)?)?;
    if !config.url.starts_with("wss://") {
        return Err("WSS required".into());
    }
    if config.workspaces.iter().filter(|w| w.is_default).count() != 1 {
        return Err("configure exactly one default workspace".into());
    }
    let mut ids = std::collections::HashSet::new();
    for w in &config.workspaces {
        if !ids.insert(&w.workspace_id)
            || !PathBuf::from(&w.path).is_absolute()
            || !PathBuf::from(&w.path).is_dir()
        {
            return Err("invalid workspace".into());
        }
    }
    fs::create_dir_all(&config.data_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&config.data_dir, fs::Permissions::from_mode(0o700))?;
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(config.data_dir.join("worker.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| "data directory already locked")?;
    let db = Connection::open(config.data_dir.join("ledger.sqlite"))?;
    let ledger_id = identity(&db)?;
    db.execute(
        "INSERT OR IGNORE INTO meta VALUES ('worker_id',?1)",
        [&config.worker_id],
    )?;
    let persisted: String =
        db.query_row("SELECT value FROM meta WHERE key='worker_id'", [], |r| {
            r.get(0)
        })?;
    if persisted != config.worker_id {
        return Err("worker_id conflicts with data directory".into());
    }
    let boot_id = Uuid::new_v4().to_string();
    let token = std::env::var("WORKER_TOKEN")?;
    let mut request = config.url.clone().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {token}"))?,
    );
    let (mut socket, _) = connect_async(request).await?;
    socket.send(Message::Text(serde_json::to_string(&json!({"protocol_version":1,"type":"register","worker_id":config.worker_id,"boot_id":boot_id,"ledger_id":ledger_id,"workspaces":config.workspaces}))?.into())).await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await?
        .ok_or("connection closed")??;
    let ack = parse_frame(first.to_text()?)?;
    if ack["type"] != "register_ack" || ack["worker_id"] != config.worker_id {
        return Err("invalid register ack".into());
    }
    let epoch = ack["connection_epoch"].as_u64().ok_or("missing epoch")?;
    // P1 has no calls; a non-empty future ledger must never use this empty-ledger handshake.
    socket.send(Message::Text(json!({"protocol_version":1,"type":"resume","worker_id":config.worker_id,"connection_epoch":epoch}).to_string().into())).await?;
    socket.send(Message::Text(json!({"protocol_version":1,"type":"reconcile","worker_id":config.worker_id,"connection_epoch":epoch,"ledger_id":ledger_id,"ready":true}).to_string().into())).await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
         _=heartbeat.tick()=>socket.send(Message::Text(json!({"protocol_version":1,"type":"heartbeat","worker_id":config.worker_id,"connection_epoch":epoch}).to_string().into())).await?,
         message=socket.next()=> {let Some(message)=message else {break};let message=message?;if message.is_close(){break;}if message.is_binary(){return Err("binary frame rejected".into());}if message.is_text(){let frame=parse_frame(message.to_text()?)?;if frame["worker_id"]!=config.worker_id||frame["connection_epoch"]!=epoch||frame["type"]!="ack" {return Err("unexpected frame".into());}}},
         _=tokio::signal::ctrl_c()=>{socket.close(None).await?;break;}
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn ledger_persists() {
        let db = Connection::open_in_memory().unwrap();
        assert_eq!(identity(&db).unwrap(), identity(&db).unwrap());
    }
    #[test]
    fn shared_fixtures() {
        let fixtures: Value =
            serde_json::from_str(include_str!("../../packages/protocol/fixtures/frames.json"))
                .unwrap();
        for f in fixtures.as_array().unwrap() {
            assert_eq!(
                parse_frame(&f["frame"].to_string()).is_ok(),
                f["valid"].as_bool().unwrap(),
                "{}",
                f["name"]
            );
        }
        let fixtures: Value =
            serde_json::from_str(include_str!("../../packages/protocol/fixtures/hashes.json"))
                .unwrap();
        for f in fixtures.as_array().unwrap() {
            let canonical = serde_jcs::to_vec(&f["request"]).unwrap();
            assert_eq!(
                format!("{:x}", Sha256::digest(canonical)),
                f["sha256"].as_str().unwrap()
            );
        }
    }
}
