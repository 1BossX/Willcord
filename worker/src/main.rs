mod generated;
mod ledger;
mod tools;
use base64::Engine as _;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use generated::{MAX_FRAME_BYTES, ToolCall, ToolData, ToolResult, Workspace};
use ledger::{Accept, CallIdentity, Ledger};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::{
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpStream, sync::mpsc};
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{
        self, Message, client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig,
    },
};
use uuid::Uuid;

type Error = Box<dyn std::error::Error + Send + Sync>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const DEFAULT_RESULT_RETENTION_SECS: u64 = 7 * 24 * 3600;
const HEARTBEAT: Duration = Duration::from_secs(10);
const SERVER_SILENCE: Duration = Duration::from_secs(30);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    worker_id: String,
    data_dir: PathBuf,
    url: String,
    workspaces: Vec<Workspace>,
    /// How long acknowledged results stay readable before only a tombstone remains.
    #[serde(default)]
    result_retention_secs: Option<u64>,
}

/// A connection-level failure. The process keeps its ledger and running calls
/// and reconnects; every other error is fatal.
#[derive(Debug)]
struct Retry(String);
impl std::fmt::Display for Retry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Retry {}
fn retry(reason: impl std::fmt::Display) -> Error {
    Box::new(Retry(reason.to_string()))
}

struct Worker {
    worker_id: String,
    url: String,
    token: String,
    boot_id: String,
    retention_ms: i64,
    workspaces: Arc<Vec<Workspace>>,
    ledger: Arc<Mutex<Ledger>>,
    completed: mpsc::UnboundedSender<String>,
}

fn parse_frame(text: &str) -> Result<Value, Error> {
    if text.len() > MAX_FRAME_BYTES {
        eprintln!("rejected oversized inbound frame: {} bytes", text.len());
        return Err("oversized frame".into());
    }
    let value: Value = serde_json::from_str(text)?;
    let schema: Value = serde_json::from_str(include_str!("../../packages/protocol/schema.json"))?;
    if !jsonschema::validator_for(&schema)?.is_valid(&value) {
        eprintln!(
            "rejected inbound frame type={:?} keys={:?}",
            value.get("type").and_then(Value::as_str),
            value.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        return Err("invalid frame".into());
    }
    Ok(value)
}

/// Crash points for the P3 fault program; compiled out of normal builds.
#[cfg(feature = "fault-injection")]
fn fault(point: &str) {
    if std::env::var("WP_FAULT").as_deref() == Ok(point) {
        eprintln!("fault injection: SIGKILL at {point}");
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
    }
}
#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
fn fault(_: &str) {}

#[tokio::main]
async fn main() -> Result<(), Error> {
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
    let mut ledger = Ledger::open(
        Connection::open(config.data_dir.join("ledger.sqlite"))?,
        &config.worker_id,
    )?;
    let boot_id = Uuid::new_v4().to_string();
    let orphaned = ledger.begin_boot(&boot_id)?;
    if orphaned > 0 {
        eprintln!("{orphaned} call(s) from an earlier boot are unknown; worker stays blocked");
    }
    let retention_ms = (config
        .result_retention_secs
        .unwrap_or(DEFAULT_RESULT_RETENTION_SECS)
        * 1000) as i64;
    ledger.retire_acknowledged(retention_ms)?;
    let (completed, mut completed_rx) = mpsc::unbounded_channel();
    let worker = Worker {
        worker_id: config.worker_id,
        url: config.url,
        token: std::env::var("WORKER_TOKEN")?,
        boot_id,
        retention_ms,
        workspaces: Arc::new(config.workspaces),
        ledger: Arc::new(Mutex::new(ledger)),
        completed,
    };
    let mut backoff = Duration::from_secs(1);
    loop {
        let mut registered = false;
        match session(&worker, &mut completed_rx, &mut registered).await {
            Ok(()) => return Ok(()),
            Err(error) if error.is::<Retry>() => {
                if registered {
                    backoff = Duration::from_secs(1);
                }
                eprintln!("connection lost: {error}; reconnecting in {backoff:?}");
            }
            Err(error) => return Err(error),
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

async fn connect(worker: &Worker) -> Result<Socket, Error> {
    let mut request = worker.url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", worker.token))?,
    );
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    match connect_async_with_config(request, Some(websocket_config), false).await {
        Ok((socket, _)) => Ok(socket),
        // Certificate failures surface as InvalidData and a rejected token as an
        // HTTP 4xx: both need an operator, not another attempt.
        Err(tungstenite::Error::Io(e)) if e.kind() != std::io::ErrorKind::InvalidData => {
            Err(retry(e))
        }
        Err(tungstenite::Error::Http(response)) if response.status().is_server_error() => {
            Err(retry(format!("HTTP {}", response.status())))
        }
        Err(e) => Err(e.into()),
    }
}

async fn send<T: Serialize>(socket: &mut Socket, frame: &T) -> Result<(), Error> {
    let text = serde_json::to_string(frame)?;
    socket.send(Message::Text(text.into())).await.map_err(retry)
}

/// Next text frame; control frames are answered by tungstenite and skipped.
async fn next_text(socket: &mut Socket, last_inbound: &mut Instant) -> Result<String, Error> {
    loop {
        let message = match socket.next().await {
            None => return Err(retry("connection closed")),
            Some(Err(e @ tungstenite::Error::Capacity(_))) => return Err(e.into()),
            Some(Err(e)) => return Err(retry(e)),
            Some(Ok(message)) => message,
        };
        *last_inbound = Instant::now();
        match message {
            Message::Text(text) => return Ok(text.to_string()),
            Message::Close(frame) => {
                return Err(retry(format!(
                    "closed by server: {}",
                    frame.map(|f| f.reason.to_string()).unwrap_or_default()
                )));
            }
            Message::Binary(_) => return Err("binary frame rejected".into()),
            _ => {}
        }
    }
}

fn result_frame(worker: &Worker, epoch: u64, call: &CallIdentity, record: &Value) -> ToolResult {
    ToolResult {
        protocol_version: 1,
        kind: "tool_result".into(),
        worker_id: worker.worker_id.clone(),
        connection_epoch: epoch,
        job_id: call.job_id.clone(),
        call_id: call.call_id.clone(),
        request_hash: call.request_hash.clone(),
        ok: record["ok"].as_bool().unwrap_or(false),
        result: record["result"].clone(),
    }
}

async fn session(
    worker: &Worker,
    completed: &mut mpsc::UnboundedReceiver<String>,
    registered: &mut bool,
) -> Result<(), Error> {
    let mut socket = connect(worker).await?;
    let mut last_inbound = Instant::now();
    let ledger_id = worker.ledger.lock().unwrap().ledger_id.clone();
    send(
        &mut socket,
        &generated::Register {
            protocol_version: 1,
            kind: "register".to_owned(),
            worker_id: worker.worker_id.clone(),
            boot_id: worker.boot_id.clone(),
            ledger_id: ledger_id.clone(),
            workspaces: worker.workspaces.to_vec(),
        },
    )
    .await?;
    let first = tokio::time::timeout(
        Duration::from_secs(10),
        next_text(&mut socket, &mut last_inbound),
    )
    .await
    .map_err(|_| retry("register acknowledgement timed out"))??;
    let ack: generated::RegisterAck = serde_json::from_value(parse_frame(&first)?)?;
    if ack.kind != "register_ack" || ack.worker_id != worker.worker_id {
        return Err("invalid register ack".into());
    }
    *registered = true;
    let epoch = ack.connection_epoch;
    // Completion notices from before this connection are covered by the report.
    while completed.try_recv().is_ok() {}
    send(
        &mut socket,
        &generated::Resume {
            protocol_version: 1,
            worker_id: worker.worker_id.clone(),
            connection_epoch: epoch,
            kind: "resume".to_owned(),
        },
    )
    .await?;
    let calls = worker.ledger.lock().unwrap().unacknowledged()?;
    send(
        &mut socket,
        &generated::Reconcile {
            protocol_version: 1,
            worker_id: worker.worker_id.clone(),
            connection_epoch: epoch,
            kind: "reconcile".to_owned(),
            ledger_id,
            ready: true,
            calls,
        },
    )
    .await?;
    let mut reconciled = false;
    // Results already sent on this connection; a completion notice may race
    // the post-reconcile scan for the same call.
    let mut sent_results = std::collections::HashSet::new();
    let mut heartbeat = tokio::time::interval(HEARTBEAT);
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_inbound.elapsed() > SERVER_SILENCE {
                    return Err(retry("server silent"));
                }
                send(&mut socket, &generated::Heartbeat {
                    protocol_version: 1,
                    kind: "heartbeat".to_owned(),
                    worker_id: worker.worker_id.clone(),
                    connection_epoch: epoch,
                }).await?;
                socket.send(Message::Ping(Vec::new().into())).await.map_err(retry)?;
            }
            Some(call_id) = completed.recv() => {
                if !reconciled { continue; }
                let found = worker.ledger.lock().unwrap().completed_result(&call_id)?;
                if let Some((call, record)) = found
                    && sent_results.insert(call.call_id.clone())
                {
                    send(&mut socket, &result_frame(worker, epoch, &call, &record)).await?;
                }
            }
            text = next_text(&mut socket, &mut last_inbound) => {
                let frame = parse_frame(&text?)?;
                match frame["type"].as_str() {
                    Some("ack") => {
                        let ack: generated::Ack = serde_json::from_value(frame)?;
                        if ack.worker_id != worker.worker_id || ack.connection_epoch != epoch {
                            return Err("unexpected ack".into());
                        }
                        if ack.ack_type == "reconcile" && !reconciled {
                            reconciled = true;
                            send(&mut socket, &generated::WorkerReady {
                                protocol_version: 1,
                                kind: "worker_ready".into(),
                                worker_id: worker.worker_id.clone(),
                                connection_epoch: epoch,
                                ready: true,
                            }).await?;
                            let results = worker.ledger.lock().unwrap().completed_results()?;
                            for (call, record) in results {
                                sent_results.insert(call.call_id.clone());
                                send(&mut socket, &result_frame(worker, epoch, &call, &record)).await?;
                            }
                        }
                    }
                    Some("worker_ready") => {
                        let ready: generated::WorkerReady = serde_json::from_value(frame)?;
                        if ready.worker_id != worker.worker_id || ready.connection_epoch != epoch || !ready.ready {
                            return Err("worker not ready".into());
                        }
                    }
                    Some("tool_call") => {
                        if !reconciled {
                            return Err("tool call before reconciliation".into());
                        }
                        let call: ToolCall = serde_json::from_value(frame)?;
                        if call.worker_id != worker.worker_id || call.connection_epoch != epoch {
                            return Err("stale tool call".into());
                        }
                        tool_call(worker, &mut socket, &mut last_inbound, epoch, call).await?;
                    }
                    Some("tool_ack") => {
                        let ack: generated::ToolAck = serde_json::from_value(frame)?;
                        if ack.worker_id != worker.worker_id || ack.connection_epoch != epoch {
                            return Err("stale tool ack".into());
                        }
                        let mut ledger = worker.ledger.lock().unwrap();
                        ledger.acknowledge(&ack.job_id, &ack.call_id, &ack.request_hash, ack.ack_through)?;
                        ledger.retire_acknowledged(worker.retention_ms)?;
                    }
                    _ => return Err("unexpected frame".into()),
                }
            }
            _ = tokio::signal::ctrl_c() => {
                let _ = socket.close(None).await;
                return Ok(());
            }
        }
    }
}

async fn tool_call(
    worker: &Worker,
    socket: &mut Socket,
    last_inbound: &mut Instant,
    epoch: u64,
    mut call: ToolCall,
) -> Result<(), Error> {
    if call.tool == "write" {
        let count = call.arguments["transfer_chunks"]
            .as_u64()
            .ok_or("missing write chunk count")?;
        let expected_bytes = call.arguments["transfer_bytes"]
            .as_u64()
            .ok_or("missing write byte count")? as usize;
        let expected_hash = call.arguments["transfer_sha256"]
            .as_str()
            .ok_or("missing write transfer hash")?
            .to_owned();
        if count == 0 || count > 44 || expected_bytes > 1024 * 1024 {
            return Err("write transfer limit".into());
        }
        let mut bytes = Vec::with_capacity(expected_bytes);
        for index in 0..count {
            let chunk: ToolData =
                serde_json::from_value(parse_frame(&next_text(socket, last_inbound).await?)?)?;
            if chunk.worker_id != worker.worker_id
                || chunk.connection_epoch != epoch
                || chunk.job_id != call.job_id
                || chunk.call_id != call.call_id
                || chunk.request_hash != call.request_hash
                || chunk.chunk_index != index
                || chunk.is_final != (index + 1 == count)
            {
                return Err("write chunk identity or order mismatch".into());
            }
            bytes.extend(base64::engine::general_purpose::STANDARD.decode(chunk.data)?);
        }
        if bytes.len() != expected_bytes
            || format!("{:x}", sha2::Sha256::digest(&bytes)) != expected_hash
        {
            return Err("write transfer integrity mismatch".into());
        }
        let content = String::from_utf8(bytes)?;
        let args = call
            .arguments
            .as_object_mut()
            .ok_or("write arguments must be object")?;
        args.remove("transfer_bytes");
        args.remove("transfer_sha256");
        args.remove("transfer_chunks");
        args.insert("content".into(), Value::String(content));
    }
    let canonical = serde_json::json!({"worker_id":call.worker_id,"job_id":call.job_id,"call_id":call.call_id,"call_seq":call.call_seq,"workspace_id":call.workspace_id,"config_version":call.config_version,"tool":call.tool,"arguments":call.arguments});
    if format!("{:x}", sha2::Sha256::digest(serde_jcs::to_vec(&canonical)?)) != call.request_hash {
        return Err("request hash mismatch".into());
    }
    let identity = CallIdentity {
        job_id: call.job_id.clone(),
        call_id: call.call_id.clone(),
        call_seq: call.call_seq,
        request_hash: call.request_hash.clone(),
    };
    let accepted = generated::ToolAccepted {
        protocol_version: 1,
        kind: "tool_accepted".into(),
        worker_id: worker.worker_id.clone(),
        connection_epoch: epoch,
        job_id: call.job_id.clone(),
        call_id: call.call_id.clone(),
        request_hash: call.request_hash.clone(),
        boot_id: worker.boot_id.clone(),
    };
    let outcome = worker
        .ledger
        .lock()
        .unwrap()
        .accept(&identity, &worker.boot_id)?;
    match outcome {
        Accept::Execute => {
            fault("after_accepted");
            worker.ledger.lock().unwrap().mark_running(&call.call_id)?;
            fault("after_running");
            let (ledger, workspaces, completed) = (
                worker.ledger.clone(),
                worker.workspaces.clone(),
                worker.completed.clone(),
            );
            // Execution outlives the connection; its result is persisted before
            // any connection is told about it.
            tokio::spawn(async move {
                let record = match tools::execute_tool(&workspaces, &call).await {
                    Ok(result) => serde_json::json!({"ok":true,"result":result}),
                    Err(e) => serde_json::json!({"ok":false,"result":{"error":e.to_string()}}),
                };
                fault("after_effect");
                if let Err(e) = ledger.lock().unwrap().complete(&call.call_id, &record) {
                    eprintln!("ledger write failed for {}: {e}", call.call_id);
                    std::process::abort();
                }
                fault("after_result_persisted");
                let _ = completed.send(call.call_id);
            });
            // Report only once execution is under way: a lost report must not
            // leave an accepted call that no retry on this boot would start.
            send(socket, &accepted).await?;
        }
        Accept::InProgress => send(socket, &accepted).await?,
        Accept::Cached(record) => {
            send(socket, &result_frame(worker, epoch, &identity, &record)).await?
        }
        Accept::Rejected(reason) => {
            send(
                socket,
                &generated::ToolRejected {
                    protocol_version: 1,
                    kind: "tool_rejected".into(),
                    worker_id: worker.worker_id.clone(),
                    connection_epoch: epoch,
                    job_id: identity.job_id,
                    call_id: identity.call_id,
                    request_hash: identity.request_hash,
                    reason: reason.into(),
                },
            )
            .await?
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
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
    #[test]
    fn generated_frames_round_trip_through_schema() {
        let report = generated::CallReport {
            job_id: "job-1".into(),
            call_id: "call-1".into(),
            call_seq: 1,
            request_hash: "a".repeat(64),
            status: "completed".into(),
            boot_id: "boot".into(),
        };
        let frame = generated::Reconcile {
            protocol_version: 1,
            worker_id: "w".into(),
            connection_epoch: 1,
            kind: "reconcile".into(),
            ledger_id: "l".into(),
            ready: true,
            calls: vec![report],
        };
        assert!(parse_frame(&serde_json::to_string(&frame).unwrap()).is_ok());
    }
}
