mod cli;
mod diagnosis;
mod generated;
mod ledger;
mod logs;
mod main_node;
mod netaddr;
mod path_install;
mod platform;
mod process;
mod tools;
mod trust;
use base64::Engine as _;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use generated::{MAX_FRAME_BYTES, ToolCall, ToolData, ToolResult, Workspace};
use ledger::{Accept, CallIdentity, Ledger};
use logs::Chunk;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpStream, UnixListener, UnixStream},
    sync::{Notify, mpsc, oneshot, watch},
};
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
/// The protocol's hard ceiling for any tool time limit.
const MAX_TOOL_TIMEOUT_SECS: u64 = 1800;
const DEFAULT_KILL_GRACE_SECS: u64 = 10;
const MAX_KILL_GRACE_SECS: u64 = 30;
const STOP_CONFIRM: Duration = Duration::from_secs(5);
const DEFAULT_LOG_DISK_BUDGET: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES: u64 = 1024 * 1024 * 1024;
/// PATH of every command; the worker's own environment is never passed on.
const DEFAULT_COMMAND_PATH: &str = "/usr/local/bin:/usr/bin:/bin";
/// Chunks answered per log_fetch; the main node asks again for more.
const LOG_FETCH_BATCH: u64 = 64;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Config {
    worker_id: String,
    data_dir: PathBuf,
    url: String,
    workspaces: Vec<Workspace>,
    /// File holding the worker token, reread on every connection so a rotated
    /// token takes effect on reconnect. Without it, WORKER_TOKEN is used.
    #[serde(default)]
    token_file: Option<PathBuf>,
    /// How long acknowledged results stay readable before only a tombstone remains.
    #[serde(default)]
    result_retention_secs: Option<u64>,
    /// Seconds between TERM and KILL when a command is cancelled or times out.
    #[serde(default)]
    kill_grace_secs: Option<u64>,
    /// Local bash time limit cap; at most 1800.
    #[serde(default)]
    max_tool_timeout_secs: Option<u64>,
    /// Stored command output across all calls; new calls are refused above it.
    #[serde(default)]
    log_disk_budget_bytes: Option<u64>,
    /// New calls are refused when less space than this is free.
    #[serde(default)]
    min_free_bytes: Option<u64>,
    /// PATH for commands, e.g. with /opt/homebrew/bin on Apple Silicon.
    #[serde(default)]
    command_path: Option<String>,
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

/// Where the bearer token comes from: fixed from the environment, or a file
/// read again before each connection.
enum TokenSource {
    Env(String),
    File(PathBuf),
}
impl TokenSource {
    fn new(file: Option<PathBuf>, env: Option<String>) -> Result<Self, Error> {
        match (file, env) {
            (Some(path), None) => Ok(Self::File(path)),
            (None, Some(token)) => Ok(Self::Env(token)),
            (Some(_), Some(_)) => Err("set token_file or WORKER_TOKEN, not both".into()),
            (None, None) => Err("token_file or WORKER_TOKEN required".into()),
        }
    }
    fn read(&self) -> Result<String, Error> {
        let token = match self {
            Self::Env(token) => token.clone(),
            Self::File(path) => {
                use std::os::unix::fs::PermissionsExt;
                if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
                    return Err("token_file must not be readable by group or others".into());
                }
                fs::read_to_string(path)?.trim().to_string()
            }
        };
        if token.is_empty() {
            return Err("worker token is empty".into());
        }
        Ok(token)
    }
}

struct Worker {
    worker_id: String,
    url: String,
    token: TokenSource,
    boot_id: String,
    retention_ms: i64,
    workspaces: Arc<Vec<Workspace>>,
    ledger: Arc<Mutex<Ledger>>,
    completed: mpsc::UnboundedSender<String>,
    data_dir: PathBuf,
    log_root: PathBuf,
    limits: Arc<process::Limits>,
    max_tool_timeout_secs: u64,
    log_disk_budget: u64,
    min_free_bytes: u64,
    /// Stop switches of calls running on this boot.
    cancels: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    live_logs: mpsc::Sender<Chunk>,
    /// SIGINT, stored until observed. A `ctrl_c()` future made per loop
    /// iteration misses signals that arrive while a frame is being handled.
    shutdown: Arc<Notify>,
}

struct WorkspaceChange {
    config: String,
    response: oneshot::Sender<Result<(), String>>,
}

async fn handle_workspace_control(
    mut socket: UnixStream,
    data_dir: PathBuf,
    config_file: PathBuf,
    updates: &mpsc::Sender<WorkspaceChange>,
) -> Result<(), Error> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let result: Result<(), Error> = async {
        let mut reader = BufReader::new(&mut socket);
        let mut line = String::new();
        let bytes =
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line)).await??;
        if bytes == 0 || line.len() > 4096 {
            return Err("invalid workspace control request".into());
        }
        let request: Value = serde_json::from_str(&line)?;
        let id = request["workspace_id"]
            .as_str()
            .ok_or("workspace ID required")?;
        let path = request["path"].as_str().ok_or("workspace path required")?;
        let mut config: Config = toml::from_str(&fs::read_to_string(&config_file)?)?;
        if id.is_empty()
            || id.len() > 128
            || !PathBuf::from(path).is_absolute()
            || !PathBuf::from(path).is_dir()
            || config.workspaces.iter().any(|w| w.workspace_id == id)
        {
            return Err("invalid or duplicate workspace".into());
        }

        // The server rejects this while a job owns the slot and leaves its WSS
        // connection intact. Only a successful idle preflight may interrupt it.
        cli::proof(&data_dir, "workspace").await?;

        let version = config
            .workspaces
            .iter()
            .map(|w| w.config_version)
            .max()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("workspace version exhausted")?;
        for workspace in &mut config.workspaces {
            workspace.config_version = version;
        }
        config.workspaces.push(Workspace {
            workspace_id: id.into(),
            path: path.into(),
            repo_id: format!("local/{id}"),
            config_version: version,
            is_default: false,
        });

        let (response, accepted) = oneshot::channel();
        updates
            .send(WorkspaceChange {
                config: toml::to_string_pretty(&config)?,
                response,
            })
            .await
            .map_err(|_| "worker is shutting down")?;
        match tokio::time::timeout(Duration::from_secs(10), accepted).await?? {
            Ok(()) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
    .await;

    let response = match result {
        Ok(()) => "ok\n".to_owned(),
        Err(error) => format!("{error}\n"),
    };
    socket.write_all(response.as_bytes()).await?;
    Ok(())
}

fn validator() -> &'static jsonschema::Validator {
    static VALIDATOR: OnceLock<jsonschema::Validator> = OnceLock::new();
    VALIDATOR.get_or_init(|| {
        let schema: Value =
            serde_json::from_str(include_str!("../../packages/protocol/schema.json")).unwrap();
        jsonschema::validator_for(&schema).unwrap()
    })
}

fn parse_frame(text: &str) -> Result<Value, Error> {
    if text.len() > MAX_FRAME_BYTES {
        eprintln!("rejected oversized inbound frame: {} bytes", text.len());
        return Err("oversized frame".into());
    }
    let value: Value = serde_json::from_str(text)?;
    if !validator().is_valid(&value) {
        eprintln!(
            "rejected inbound frame type={:?} keys={:?}",
            value.get("type").and_then(Value::as_str),
            value.as_object().map(|o| o.keys().collect::<Vec<_>>())
        );
        return Err("invalid frame".into());
    }
    Ok(value)
}

/// Crash points for the fault programs; compiled out of normal builds.
#[cfg(feature = "fault-injection")]
pub(crate) fn fault(point: &str) {
    if std::env::var("WP_FAULT").as_deref() == Ok(point) {
        eprintln!("fault injection: SIGKILL at {point}");
        unsafe {
            libc::kill(libc::getpid(), libc::SIGKILL);
        }
    }
}
#[cfg(not(feature = "fault-injection"))]
#[inline(always)]
pub(crate) fn fault(_: &str) {}

#[tokio::main]
async fn main() -> Result<(), Error> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| "TLS crypto provider unavailable")?;
    let Some(file) = cli::dispatch().await? else {
        return Ok(());
    };
    let config: Config = toml::from_str(&fs::read_to_string(&file)?)?;
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
    let max_tool_timeout_secs = config
        .max_tool_timeout_secs
        .unwrap_or(MAX_TOOL_TIMEOUT_SECS);
    if !(1..=MAX_TOOL_TIMEOUT_SECS).contains(&max_tool_timeout_secs) {
        return Err("max_tool_timeout_secs must be 1..=1800".into());
    }
    // The main node waits the time limit plus a fixed margin for a stop to be confirmed.
    let kill_grace_secs = config.kill_grace_secs.unwrap_or(DEFAULT_KILL_GRACE_SECS);
    if kill_grace_secs > MAX_KILL_GRACE_SECS {
        return Err("kill_grace_secs must be at most 30".into());
    }
    let command_path = config
        .command_path
        .clone()
        .unwrap_or_else(|| DEFAULT_COMMAND_PATH.to_string());
    if command_path
        .split(':')
        .any(|dir| !std::path::Path::new(dir).is_absolute())
    {
        return Err("command_path must list absolute directories separated by ':'".into());
    }
    ledger.retire_acknowledged(retention_ms)?;
    let log_root = config.data_dir.join("logs");
    fs::create_dir_all(&log_root)?;
    logs::prune(&log_root, &ledger.held_calls()?)?;
    let (completed, mut completed_rx) = mpsc::unbounded_channel();
    let (live_logs, mut live_logs_rx) = mpsc::channel(64);
    let shutdown = Arc::new(Notify::new());
    let listener = shutdown.clone();
    // SIGINT from a terminal and SIGTERM from systemd/launchd stop the same way.
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::spawn(async move {
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
        listener.notify_one();
    });
    let token = TokenSource::new(config.token_file, std::env::var("WORKER_TOKEN").ok())?;
    token.read()?;
    let mut worker = Worker {
        worker_id: config.worker_id,
        url: config.url,
        token,
        boot_id,
        retention_ms,
        workspaces: Arc::new(config.workspaces),
        ledger: Arc::new(Mutex::new(ledger)),
        completed,
        data_dir: config.data_dir.clone(),
        log_root,
        limits: Arc::new(process::Limits {
            grace: Duration::from_secs(kill_grace_secs),
            confirm: STOP_CONFIRM,
            command_path,
        }),
        max_tool_timeout_secs,
        log_disk_budget: config
            .log_disk_budget_bytes
            .unwrap_or(DEFAULT_LOG_DISK_BUDGET),
        min_free_bytes: config.min_free_bytes.unwrap_or(DEFAULT_MIN_FREE_BYTES),
        cancels: Arc::new(Mutex::new(HashMap::new())),
        live_logs,
        shutdown,
    };
    // A hand-installed worker names its own data_dir; fail with the cause, not
    // the OS's "path must be shorter than SUN_LEN".
    cli::check_socket_path(&worker.data_dir)?;
    let socket_path = worker.data_dir.join("control.sock");
    if socket_path.exists() {
        fs::remove_file(&socket_path)?;
    }
    let control = UnixListener::bind(&socket_path)?;
    let (control_updates, mut control_updates_rx) = mpsc::channel::<WorkspaceChange>(1);
    let control_data_dir = worker.data_dir.clone();
    let control_config_file = file.clone();
    tokio::spawn(async move {
        loop {
            match control.accept().await {
                Ok((socket, _)) => {
                    if let Err(error) = handle_workspace_control(
                        socket,
                        control_data_dir.clone(),
                        control_config_file.clone(),
                        &control_updates,
                    )
                    .await
                    {
                        eprintln!("workspace control request failed: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("workspace control socket failed: {error}");
                    break;
                }
            }
        }
    });
    let mut backoff = Duration::from_secs(1);
    loop {
        if worker.data_dir.join("enrollment.json").exists() {
            if let Ok(credential) = cli::proof(&worker.data_dir, "credentials").await {
                if let Some(token) = credential["token"].as_str() {
                    cli::save(&worker.data_dir.join("token"), token.as_bytes())?;
                }
            }
        }
        let mut registered = false;
        // Shutdown cancels the session wherever it is waiting: inside a frame
        // handler, a chunked transfer or the handshake. Ledger writes are
        // synchronous, so cancellation never splits one.
        let outcome = tokio::select! {
            outcome = session(&worker, &mut completed_rx, &mut live_logs_rx, &mut registered) => outcome,
            _ = worker.shutdown.notified() => return stop_running(&worker).await,
            change = control_updates_rx.recv() => {
                if let Some(change) = change {
                    let result: Result<(), Error> = (|| {
                        let config: Config = toml::from_str(&change.config)?;
                        cli::save(&file, change.config.as_bytes())?;
                        worker.workspaces = Arc::new(config.workspaces);
                        Ok(())
                    })();
                    let _ = change.response.send(result.map_err(|error| error.to_string()));
                }
                continue;
            },
        };
        match outcome {
            Ok(()) => return Ok(()),
            Err(error) if error.is::<Retry>() => {
                if registered {
                    backoff = Duration::from_secs(1);
                }
                cli::record_status(&worker.data_dir, Some(error.to_string()));
                eprintln!("connection lost: {error}; reconnecting in {backoff:?}");
            }
            Err(error) => {
                cli::record_status(&worker.data_dir, Some(error.to_string()));
                return Err(error);
            }
        }
        tokio::select! {
            _ = tokio::time::sleep(backoff) => {}
            _ = worker.shutdown.notified() => return stop_running(&worker).await,
        }
        backoff = (backoff * 2).min(MAX_BACKOFF);
    }
}

/// On shutdown, stop every running command through the normal cancel path and
/// wait for its result to be persisted, so no process group outlives the worker.
async fn stop_running(worker: &Worker) -> Result<(), Error> {
    for stop in worker.cancels.lock().unwrap().values() {
        let _ = stop.send(true);
    }
    let deadline =
        Instant::now() + worker.limits.grace + worker.limits.confirm + Duration::from_secs(2);
    while !worker.cancels.lock().unwrap().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

async fn connect(worker: &Worker) -> Result<Socket, Error> {
    let mut request = worker.url.as_str().into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {}", worker.token.read()?))?,
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
        Err(tungstenite::Error::Http(response))
            if worker.data_dir.join("enrollment.json").exists()
                && matches!(response.status().as_u16(), 401 | 403) =>
        {
            Err(retry(
                "device authorization unavailable; awaiting administrator",
            ))
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

fn rejected_frame(
    worker: &Worker,
    epoch: u64,
    call: &CallIdentity,
    reason: &str,
) -> generated::ToolRejected {
    generated::ToolRejected {
        protocol_version: 1,
        kind: "tool_rejected".into(),
        worker_id: worker.worker_id.clone(),
        connection_epoch: epoch,
        job_id: call.job_id.clone(),
        call_id: call.call_id.clone(),
        request_hash: call.request_hash.clone(),
        reason: reason.into(),
    }
}

/// Delete stored output the main node no longer needs.
fn prune_logs(worker: &Worker) -> Result<(), Error> {
    let ledger = worker.ledger.lock().unwrap();
    for call_id in ledger.settled_logs()? {
        logs::remove(&worker.log_root, &call_id);
    }
    logs::prune(&worker.log_root, &ledger.held_calls()?)?;
    Ok(())
}

/// Space for a new call: free disk and the stored-output budget.
fn disk_ok(worker: &Worker) -> bool {
    let free = logs::free_bytes(&worker.data_dir).unwrap_or(0);
    free >= worker.min_free_bytes && logs::usage(&worker.log_root) < worker.log_disk_budget
}

async fn session(
    worker: &Worker,
    completed: &mut mpsc::UnboundedReceiver<String>,
    live_logs: &mut mpsc::Receiver<Chunk>,
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
                    continue;
                }
                // Stopping could not be confirmed: report it now instead of
                // leaving the main node to wait for a result that never comes.
                let held = worker.ledger.lock().unwrap().call(&call_id)?;
                if let Some((call, status)) = held
                    && status == "unknown"
                {
                    send(&mut socket, &rejected_frame(worker, epoch, &call, "unknown")).await?;
                }
            }
            Some(chunk) = live_logs.recv() => {
                // Live output is a convenience; anything missed is fetched later.
                if !reconciled { continue; }
                send(&mut socket, &log_frame(worker, epoch, chunk)).await?;
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
                            cli::record_status(&worker.data_dir, None);
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
                        {
                            let mut ledger = worker.ledger.lock().unwrap();
                            ledger.acknowledge(&ack.job_id, &ack.call_id, &ack.request_hash, ack.ack_through)?;
                            ledger.retire_acknowledged(worker.retention_ms)?;
                        }
                        prune_logs(worker)?;
                    }
                    Some("cancel_call") => {
                        if !reconciled {
                            return Err("cancel before reconciliation".into());
                        }
                        let cancel: generated::CancelCall = serde_json::from_value(frame)?;
                        if cancel.worker_id != worker.worker_id || cancel.connection_epoch != epoch {
                            return Err("stale cancel".into());
                        }
                        let identity = CallIdentity {
                            job_id: cancel.job_id,
                            call_id: cancel.call_id,
                            call_seq: cancel.call_seq,
                            request_hash: cancel.request_hash,
                        };
                        let state = worker.ledger.lock().unwrap().request_cancel(&identity, &worker.boot_id)?;
                        fault("after_cancel_recorded");
                        if state == "running"
                            && let Some(stop) = worker.cancels.lock().unwrap().get(&identity.call_id)
                        {
                            let _ = stop.send(true);
                        }
                        send(&mut socket, &generated::CancelAck {
                            protocol_version: 1,
                            kind: "cancel_ack".into(),
                            worker_id: worker.worker_id.clone(),
                            connection_epoch: epoch,
                            job_id: identity.job_id,
                            call_id: identity.call_id,
                            request_hash: identity.request_hash,
                            state: state.into(),
                        }).await?;
                    }
                    Some("log_fetch") => {
                        let fetch: generated::LogFetch = serde_json::from_value(frame)?;
                        if fetch.worker_id != worker.worker_id || fetch.connection_epoch != epoch {
                            return Err("stale log fetch".into());
                        }
                        log_fetch(worker, &mut socket, epoch, fetch).await?;
                    }
                    Some("log_ack") => {
                        let ack: generated::LogAck = serde_json::from_value(frame)?;
                        if ack.worker_id != worker.worker_id || ack.connection_epoch != epoch {
                            return Err("stale log ack".into());
                        }
                        let held = worker.ledger.lock().unwrap().call(&ack.call_id)?;
                        if let Some((call, _)) = held
                            && call.job_id == ack.job_id
                            && call.request_hash == ack.request_hash
                        {
                            worker.ledger.lock().unwrap().ack_log(&ack.call_id, &ack.stream, ack.chunks)?;
                            prune_logs(worker)?;
                        }
                    }
                    Some("resolve_call") => {
                        if !reconciled {
                            return Err("resolve before reconciliation".into());
                        }
                        let resolve: generated::ResolveCall = serde_json::from_value(frame)?;
                        if resolve.worker_id != worker.worker_id || resolve.connection_epoch != epoch {
                            return Err("stale resolve".into());
                        }
                        let identity = CallIdentity {
                            job_id: resolve.job_id,
                            call_id: resolve.call_id,
                            call_seq: resolve.call_seq,
                            request_hash: resolve.request_hash,
                        };
                        let state = worker.ledger.lock().unwrap().resolve(&identity)?;
                        if state == "resolved" {
                            logs::remove(&worker.log_root, &identity.call_id);
                        }
                        send(&mut socket, &generated::ResolveAck {
                            protocol_version: 1,
                            kind: "resolve_ack".into(),
                            worker_id: worker.worker_id.clone(),
                            connection_epoch: epoch,
                            job_id: identity.job_id,
                            call_id: identity.call_id,
                            request_hash: identity.request_hash,
                            state: state.into(),
                        }).await?;
                    }
                    _ => return Err("unexpected frame".into()),
                }
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
    let mut canonical = serde_json::json!({"worker_id":call.worker_id,"job_id":call.job_id,"call_id":call.call_id,"call_seq":call.call_seq,"workspace_id":call.workspace_id,"config_version":call.config_version,"tool":call.tool,"arguments":call.arguments});
    if let Some(mode) = call.execution_mode.as_ref() {
        canonical["execution_mode"] = Value::String(mode.clone());
    }
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
    // A request this worker would never run is refused before the ledger sees it.
    if call.tool == "write" && !diagnosis::write_allowed(call.execution_mode.as_deref()) {
        send(socket, &rejected_frame(worker, epoch, &identity, "invalid")).await?;
        return Ok(());
    }
    let timeout = if call.tool == "bash" {
        let command = call.arguments["command"].as_str().unwrap_or("");
        if diagnosis::is_diagnosis(call.execution_mode.as_deref()) {
            if diagnosis::bash_allowed(command).is_err() {
                send(socket, &rejected_frame(worker, epoch, &identity, "invalid")).await?;
                return Ok(());
            }
        }
        match process::bash_timeout(&call.arguments, worker.max_tool_timeout_secs) {
            Ok(timeout) => Some(timeout),
            Err(reason) => {
                send(socket, &rejected_frame(worker, epoch, &identity, reason)).await?;
                return Ok(());
            }
        }
    } else {
        None
    };
    let outcome =
        worker
            .ledger
            .lock()
            .unwrap()
            .accept(&identity, &worker.boot_id, disk_ok(worker))?;
    match outcome {
        Accept::Execute => {
            fault("after_accepted");
            worker.ledger.lock().unwrap().mark_running(&call.call_id)?;
            fault("after_running");
            let (stop, cancel) = watch::channel(false);
            worker
                .cancels
                .lock()
                .unwrap()
                .insert(call.call_id.clone(), stop);
            let (ledger, workspaces, completed, cancels) = (
                worker.ledger.clone(),
                worker.workspaces.clone(),
                worker.completed.clone(),
                worker.cancels.clone(),
            );
            let (log_root, live_logs, limits) = (
                worker.log_root.clone(),
                worker.live_logs.clone(),
                worker.limits.clone(),
            );
            // Execution outlives the connection; its result is persisted before
            // any connection is told about it.
            tokio::spawn(async move {
                let (settled, record, streams) = match timeout {
                    Some(timeout) => {
                        run_bash(
                            &workspaces,
                            &call,
                            timeout,
                            cancel,
                            &log_root,
                            live_logs,
                            &limits,
                        )
                        .await
                    }
                    None => {
                        let record = match tools::execute_tool(&workspaces, &call).await {
                            Ok(result) => serde_json::json!({"ok":true,"result":result}),
                            Err(e) => {
                                serde_json::json!({"ok":false,"result":{"error":e.to_string()}})
                            }
                        };
                        (true, record, Vec::new())
                    }
                };
                fault("after_effect");
                let mut ledger = ledger.lock().unwrap();
                let persisted = if settled {
                    ledger.complete(&call.call_id, &record, &streams)
                } else {
                    ledger.mark_unknown(&call.call_id, &record, &streams)
                };
                if let Err(e) = persisted {
                    eprintln!("ledger write failed for {}: {e}", call.call_id);
                    std::process::abort();
                }
                drop(ledger);
                cancels.lock().unwrap().remove(&call.call_id);
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
            send(socket, &rejected_frame(worker, epoch, &identity, reason)).await?
        }
    }
    Ok(())
}

/// Run a bash call. Returns whether stopping was confirmed, the ledger record,
/// and the stored streams. Without confirmation the record is evidence only.
async fn run_bash(
    workspaces: &[Workspace],
    call: &ToolCall,
    timeout: Duration,
    cancel: watch::Receiver<bool>,
    log_root: &std::path::Path,
    live_logs: mpsc::Sender<Chunk>,
    limits: &process::Limits,
) -> (bool, Value, Vec<ledger::LogStream>) {
    let failed = |e: &dyn std::fmt::Display| {
        (
            true,
            serde_json::json!({"ok":false,"result":{"error":e.to_string()}}),
            Vec::new(),
        )
    };
    let Some(workspace) = workspaces
        .iter()
        .find(|w| w.workspace_id == call.workspace_id && w.config_version == call.config_version)
    else {
        return failed(&"workspace mismatch");
    };
    let Some(command) = call.arguments["command"].as_str() else {
        return failed(&"command required");
    };
    let log = match logs::CallLog::create(log_root, &call.job_id, &call.call_id, live_logs) {
        Ok(log) => Arc::new(log),
        Err(e) => return failed(&e),
    };
    let cwd = std::path::Path::new(&workspace.path);
    let outcome = if diagnosis::is_diagnosis(call.execution_mode.as_deref()) {
        match diagnosis::bash_argv(command) {
            Ok(argv) => {
                let hold_stdout = diagnosis::docker_inspect_argv(&argv);
                process::run_direct(
                    &argv,
                    cwd,
                    timeout,
                    cancel,
                    log.clone(),
                    limits,
                    hold_stdout,
                )
                .await
            }
            Err(e) => return failed(&e),
        }
    } else {
        process::run_bash(command, cwd, timeout, cancel, log.clone(), limits).await
    };
    let (_, streams) = log.summary();
    match outcome {
        Ok(process::Outcome::Finished(result)) => (
            true,
            serde_json::json!({"ok":true,"result":result}),
            streams,
        ),
        Ok(process::Outcome::Unconfirmed(evidence)) => (
            false,
            serde_json::json!({"ok":false,"result":evidence}),
            streams,
        ),
        // Spawning failed: nothing ran.
        Err(e) => (
            true,
            serde_json::json!({"ok":false,"result":{"error":e.to_string()}}),
            streams,
        ),
    }
}

fn log_frame(worker: &Worker, epoch: u64, chunk: Chunk) -> generated::ToolLog {
    generated::ToolLog {
        protocol_version: 1,
        kind: "tool_log".into(),
        worker_id: worker.worker_id.clone(),
        connection_epoch: epoch,
        job_id: chunk.job_id,
        call_id: chunk.call_id,
        stream: chunk.stream.into(),
        seq: chunk.seq,
        offset: chunk.offset,
        data: base64::engine::general_purpose::STANDARD.encode(chunk.data),
    }
}

/// Answer a log_fetch with stored chunks and a closing log_status.
async fn log_fetch(
    worker: &Worker,
    socket: &mut Socket,
    epoch: u64,
    fetch: generated::LogFetch,
) -> Result<(), Error> {
    let held = worker.ledger.lock().unwrap().call(&fetch.call_id)?;
    let status = match &held {
        Some((call, status))
            if call.job_id == fetch.job_id && call.request_hash == fetch.request_hash =>
        {
            Some(status.clone())
        }
        _ => None,
    };
    let stream: &'static str = if fetch.stream == "stderr" {
        "stderr"
    } else {
        "stdout"
    };
    let stored = match status {
        Some(_) => logs::read(
            &worker.log_root,
            &fetch.call_id,
            stream,
            fetch.from_seq,
            LOG_FETCH_BATCH,
        )?,
        None => None,
    };
    let (state, chunks) = match stored {
        None => ("expired", 0),
        Some((found, total)) => {
            let last = found
                .last()
                .map(|(seq, _, _)| seq + 1)
                .unwrap_or(fetch.from_seq);
            for (seq, offset, data) in found {
                let chunk = Chunk {
                    job_id: fetch.job_id.clone(),
                    call_id: fetch.call_id.clone(),
                    stream,
                    seq,
                    offset,
                    data,
                };
                send(socket, &log_frame(worker, epoch, chunk)).await?;
            }
            let running = matches!(status.as_deref(), Some("accepted" | "running"));
            (
                if running {
                    "running"
                } else if last < total {
                    "more"
                } else {
                    "complete"
                },
                total,
            )
        }
    };
    send(
        socket,
        &generated::LogStatus {
            protocol_version: 1,
            kind: "log_status".into(),
            worker_id: worker.worker_id.clone(),
            connection_epoch: epoch,
            job_id: fetch.job_id,
            call_id: fetch.call_id,
            stream: stream.into(),
            chunks,
            state: state.into(),
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn token_file_is_reread_and_must_be_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("wp-token-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("token");
        fs::write(&path, "first\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let source = TokenSource::new(Some(path.clone()), None).unwrap();
        assert_eq!(source.read().unwrap(), "first");
        fs::write(&path, "second").unwrap();
        assert_eq!(
            source.read().unwrap(),
            "second",
            "rotation is picked up on the next read"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            source.read().is_err(),
            "a token readable by others is refused"
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(&path, " \n").unwrap();
        assert!(source.read().is_err(), "an empty token is refused");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn token_source_needs_exactly_one_origin() {
        assert!(TokenSource::new(None, None).is_err());
        assert!(TokenSource::new(Some("/x".into()), Some("t".into())).is_err());
        assert_eq!(
            TokenSource::new(None, Some("t".into()))
                .unwrap()
                .read()
                .unwrap(),
            "t"
        );
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
