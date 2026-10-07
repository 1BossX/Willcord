mod generated;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use generated::{MAX_FRAME_BYTES, Workspace};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    time::Duration,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{
        Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};
use uuid::Uuid;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    worker_id: String,
    data_dir: PathBuf,
    url: String,
    workspaces: Vec<Workspace>,
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
    if text.len() > MAX_FRAME_BYTES {
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
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let (mut socket, _) = connect_async_with_config(request, Some(websocket_config), false).await?;
    let register = generated::Register {
        protocol_version: 1,
        kind: "register".to_owned(),
        worker_id: config.worker_id.clone(),
        boot_id,
        ledger_id: ledger_id.clone(),
        workspaces: config.workspaces.clone(),
    };
    socket
        .send(Message::Text(serde_json::to_string(&register)?.into()))
        .await?;
    let first = tokio::time::timeout(Duration::from_secs(10), socket.next())
        .await?
        .ok_or("connection closed")??;
    let ack: generated::RegisterAck = serde_json::from_value(parse_frame(first.to_text()?)?)?;
    if ack.kind != "register_ack" || ack.worker_id != config.worker_id {
        return Err("invalid register ack".into());
    }
    let epoch = ack.connection_epoch;
    // P1 has no calls; a non-empty future ledger must never use this empty-ledger handshake.
    socket
        .send(Message::Text(
            serde_json::to_string(&generated::Resume {
                protocol_version: 1,
                worker_id: config.worker_id.clone(),
                connection_epoch: epoch,
                kind: "resume".to_owned(),
            })?
            .into(),
        ))
        .await?;
    socket
        .send(Message::Text(
            serde_json::to_string(&generated::Reconcile {
                protocol_version: 1,
                worker_id: config.worker_id.clone(),
                connection_epoch: epoch,
                kind: "reconcile".to_owned(),
                ledger_id,
                ready: true,
            })?
            .into(),
        ))
        .await?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
         _=heartbeat.tick()=>socket.send(Message::Text(serde_json::to_string(&generated::Heartbeat{protocol_version:1,kind:"heartbeat".to_owned(),worker_id:config.worker_id.clone(),connection_epoch:epoch})?.into())).await?,
         message=socket.next()=> {let Some(message)=message else {break};let message=message?;if message.is_close(){break;}if message.is_binary(){return Err("binary frame rejected".into());}if message.is_text(){let frame=parse_frame(message.to_text()?)?;let ack:generated::Ack=serde_json::from_value(frame)?;if ack.worker_id!=config.worker_id||ack.connection_epoch!=epoch||ack.kind!="ack" {return Err("unexpected frame".into());}}},
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
    #[test]
    fn frame_limit_comes_from_the_shared_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../packages/protocol/schema.json")).unwrap();
        assert_eq!(
            schema["x-max-frame-bytes"].as_u64().unwrap(),
            MAX_FRAME_BYTES as u64
        );
    }
    #[test]
    fn rejects_oversized_frame_before_json_parsing() {
        let text = " ".repeat(MAX_FRAME_BYTES + 1);
        assert!(parse_frame(&text).is_err());
    }
}
