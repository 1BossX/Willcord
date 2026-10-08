mod generated;
use base64::Engine as _;
use fs2::FileExt;
use futures_util::{SinkExt, StreamExt};
use generated::{MAX_FRAME_BYTES, ToolCall, ToolData, ToolResult, Workspace};
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde_json::Value;
use sha2::Digest;
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
    db.execute_batch("CREATE TABLE IF NOT EXISTS calls(call_id TEXT PRIMARY KEY,job_id TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT);")?;
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
         message=socket.next()=> {let Some(message)=message else {break};let message=message?;if message.is_close(){break;}if message.is_binary(){return Err("binary frame rejected".into());}if message.is_text(){let frame=parse_frame(message.to_text()?)?;match frame["type"].as_str(){Some("ack")=>{let ack:generated::Ack=serde_json::from_value(frame)?;if ack.worker_id!=config.worker_id||ack.connection_epoch!=epoch||!matches!(ack.ack_type.as_str(),"resume"|"reconcile"){return Err("unexpected ack".into());}if ack.ack_type=="reconcile"{socket.send(Message::Text(serde_json::to_string(&generated::WorkerReady{protocol_version:1,kind:"worker_ready".into(),worker_id:config.worker_id.clone(),connection_epoch:epoch,ready:true})?.into())).await?;}},Some("worker_ready")=>{let ready:generated::WorkerReady=serde_json::from_value(frame)?;if ready.worker_id!=config.worker_id||ready.connection_epoch!=epoch||!ready.ready{return Err("worker not ready".into());}},Some("tool_call")=>{let mut call:ToolCall=serde_json::from_value(frame)?;if call.worker_id!=config.worker_id||call.connection_epoch!=epoch{return Err("stale tool call".into());}if call.tool=="write"{let count=call.arguments["transfer_chunks"].as_u64().ok_or("missing write chunk count")?;let expected_bytes=call.arguments["transfer_bytes"].as_u64().ok_or("missing write byte count")? as usize;let expected_hash=call.arguments["transfer_sha256"].as_str().ok_or("missing write transfer hash")?.to_owned();if count==0||count>44||expected_bytes>1024*1024{return Err("write transfer limit".into());}let mut bytes=Vec::with_capacity(expected_bytes);for index in 0..count{let message=socket.next().await.ok_or("missing write chunk")??;if !message.is_text(){return Err("write chunk must be text".into());}let data_frame=parse_frame(message.to_text()?)?;let chunk:ToolData=serde_json::from_value(data_frame)?;if chunk.worker_id!=config.worker_id||chunk.connection_epoch!=epoch||chunk.job_id!=call.job_id||chunk.call_id!=call.call_id||chunk.request_hash!=call.request_hash||chunk.chunk_index!=index||chunk.is_final!=(index+1==count){return Err("write chunk identity or order mismatch".into());}bytes.extend(base64::engine::general_purpose::STANDARD.decode(chunk.data)?);}if bytes.len()!=expected_bytes||format!("{:x}",sha2::Sha256::digest(&bytes))!=expected_hash{return Err("write transfer integrity mismatch".into());}let content=String::from_utf8(bytes)?;let args=call.arguments.as_object_mut().ok_or("write arguments must be object")?;args.remove("transfer_bytes");args.remove("transfer_sha256");args.remove("transfer_chunks");args.insert("content".into(),Value::String(content));}let canonical=serde_json::json!({"worker_id":call.worker_id,"job_id":call.job_id,"call_id":call.call_id,"call_seq":call.call_seq,"workspace_id":call.workspace_id,"config_version":call.config_version,"tool":call.tool,"arguments":call.arguments});let calculated=format!("{:x}",sha2::Sha256::digest(serde_jcs::to_vec(&canonical)?));if calculated!=call.request_hash{return Err("request hash mismatch".into());}let existing:Option<(String,Option<String>)>=db.query_row("SELECT request_hash,result_json FROM calls WHERE call_id=?1",[&call.call_id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;let (ok,result)=if let Some((hash,result))=existing{if hash!=call.request_hash{return Err("call id conflict".into());}if let Some(result)=result{let parsed:Value=serde_json::from_str(&result)?;(parsed["ok"].as_bool().unwrap_or(false),parsed["result"].clone())}else{return Err("uncertain call blocks worker".into());}}else{db.execute("INSERT INTO calls(call_id,job_id,request_hash,state) VALUES(?1,?2,?3,'running')",(&call.call_id,&call.job_id,&call.request_hash))?;let executed=execute_tool(&config.workspaces,&call).await;let (ok,result)=match executed{Ok(v)=>(true,v),Err(e)=>(false,serde_json::json!({"error":e.to_string()}))};let record=serde_json::json!({"ok":ok,"result":result});db.execute("UPDATE calls SET state='finished',result_json=?1 WHERE call_id=?2",(record.to_string(),&call.call_id))?;(ok,result)};socket.send(Message::Text(serde_json::to_string(&ToolResult{protocol_version:1,kind:"tool_result".into(),worker_id:config.worker_id.clone(),connection_epoch:epoch,job_id:call.job_id,call_id:call.call_id,request_hash:call.request_hash,ok,result})?.into())).await?;},Some("tool_ack")=>{let ack:generated::ToolAck=serde_json::from_value(frame)?;if ack.worker_id!=config.worker_id||ack.connection_epoch!=epoch{return Err("stale tool ack".into());}let row:Option<(String,String)>=db.query_row("SELECT request_hash,state FROM calls WHERE call_id=?1 AND job_id=?2",(&ack.call_id,&ack.job_id),|r|Ok((r.get(0)?,r.get(1)?))).optional()?;let Some((hash,state))=row else{return Err("unknown tool ack".into());};if hash!=ack.request_hash{return Err("tool ack hash mismatch".into());}if state!="acked"{db.execute("UPDATE calls SET state='acked' WHERE call_id=?1",[&ack.call_id])?;}},_=>return Err("unexpected frame".into())}}},
         _=tokio::signal::ctrl_c()=>{socket.close(None).await?;break;}
        }
    }
    Ok(())
}
async fn execute_tool(
    workspaces: &[Workspace],
    call: &ToolCall,
) -> Result<Value, Box<dyn std::error::Error>> {
    let workspace = workspaces
        .iter()
        .find(|w| w.workspace_id == call.workspace_id && w.config_version == call.config_version)
        .ok_or("workspace mismatch")?;
    let args = &call.arguments;
    match call.tool.as_str() {
        "read" => {
            let bytes = read_workspace_file(
                &workspace.path,
                args["path"].as_str().ok_or("path required")?,
            )?;
            if bytes.len() > 256 * 1024 {
                return Err("file exceeds read limit".into());
            }
            let text = String::from_utf8(bytes.clone())?;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(6000).min(6000) as usize;
            let chars: Vec<char> = text.chars().collect();
            let part: String = chars.iter().skip(offset).take(limit).collect();
            Ok(
                serde_json::json!({"text":part,"offset":offset,"total_chars":chars.len(),"truncated":offset+limit<chars.len(),"sha256":format!("{:x}",sha2::Sha256::digest(&bytes))}),
            )
        }
        "write" => {
            let relative = args["path"].as_str().ok_or("path required")?;
            let content = args["content"].as_str().ok_or("content required")?;
            if content.len() > 1024 * 1024 {
                return Err("write exceeds 1 MiB".into());
            }
            let expected = args["expected_hash"]
                .as_str()
                .ok_or("expected_hash required")?;
            atomic_write_workspace_file(&workspace.path, relative, content.as_bytes(), expected)?;
            Ok(
                serde_json::json!({"sha256":format!("{:x}",sha2::Sha256::digest(content.as_bytes())),"bytes":content.len()}),
            )
        }
        "bash" => {
            let command = args["command"].as_str().ok_or("command required")?;
            let cwd = PathBuf::from(&workspace.path);
            let command = tokio::process::Command::new("/bin/bash")
                .args(["--noprofile", "--norc", "-c", command])
                .current_dir(cwd)
                .env_clear()
                .env("PATH", "/usr/local/bin:/usr/bin:/bin")
                .env("HOME", std::env::var("HOME").unwrap_or_default())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .kill_on_drop(true)
                .output();
            let output = tokio::time::timeout(Duration::from_secs(600), command).await??;
            let out = String::from_utf8_lossy(&output.stdout)
                .chars()
                .take(3500)
                .collect::<String>();
            let err = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(3500)
                .collect::<String>();
            Ok(
                serde_json::json!({"exit_code":output.status.code(),"stdout":out,"stderr":err,"truncated":output.stdout.len()>14000||output.stderr.len()>14000}),
            )
        }
        _ => Err("tool not allowed".into()),
    }
}
fn workspace_parent(
    root: &str,
    relative: &str,
) -> Result<(std::os::fd::OwnedFd, std::ffi::CString), Box<dyn std::error::Error>> {
    use std::os::{
        fd::{FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    };
    use std::path::Component;
    let parts: Vec<std::ffi::CString> = std::path::Path::new(relative)
        .components()
        .map(
            |c| -> Result<std::ffi::CString, Box<dyn std::error::Error>> {
                match c {
                    Component::Normal(v) => Ok(std::ffi::CString::new(v.as_bytes())?),
                    _ => Err(Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "path traversal",
                    ))),
                }
            },
        )
        .collect::<Result<_, _>>()?;
    let (leaf, parents) = parts
        .split_last()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty path"))?;
    let root = fs::canonicalize(root)?;
    let root_c = std::ffi::CString::new(root.as_os_str().as_bytes())?;
    let fd = unsafe {
        libc::open(
            root_c.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut dir = unsafe { OwnedFd::from_raw_fd(fd) };
    for component in parents {
        let next = unsafe {
            libc::openat(
                std::os::fd::AsRawFd::as_raw_fd(&dir),
                component.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        dir = unsafe { OwnedFd::from_raw_fd(next) };
    }
    Ok((dir, leaf.clone()))
}
fn read_workspace_file(root: &str, relative: &str) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    let (dir, leaf) = workspace_parent(root, relative)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            leaf.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let mut bytes = Vec::new();
    use std::io::Read;
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}
fn atomic_write_workspace_file(
    root: &str,
    relative: &str,
    content: &[u8],
    expected_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::fs::PermissionsExt,
    };
    let (dir, leaf) = workspace_parent(root, relative)?;
    let existing_fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            leaf.as_ptr(),
            libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    let (actual, mode) = if existing_fd >= 0 {
        let mut file = fs::File::from(unsafe { OwnedFd::from_raw_fd(existing_fd) });
        let mut old = Vec::new();
        use std::io::Read;
        file.read_to_end(&mut old)?;
        (
            format!("{:x}", sha2::Sha256::digest(&old)),
            Some(file.metadata()?.permissions().mode()),
        )
    } else {
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.into());
        }
        ("missing".to_owned(), None)
    };
    if expected_hash != actual {
        return Err("expected_hash_mismatch".into());
    }
    let tmp = std::ffi::CString::new(format!(".worker-plane-{}.tmp", Uuid::new_v4()))?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            tmp.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            0o600,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let mut file = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    let write_result = (|| -> Result<(), Box<dyn std::error::Error>> {
        use std::io::Write;
        file.write_all(content)?;
        file.sync_all()?;
        if let Some(mode) = mode {
            file.set_permissions(fs::Permissions::from_mode(mode))?;
        }
        let rc = unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                tmp.as_ptr(),
                dir.as_raw_fd(),
                leaf.as_ptr(),
            )
        };
        if rc < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        if unsafe { libc::fsync(dir.as_raw_fd()) } < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    })();
    if write_result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), tmp.as_ptr(), 0) };
    }
    write_result
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
    #[test]
    fn workspace_files_reject_symlink_escape_and_replace_atomically() {
        use std::os::unix::fs::symlink;
        let temp = std::env::temp_dir().join(format!("worker-plane-path-test-{}", Uuid::new_v4()));
        let root = temp.join("workspace");
        let outside = temp.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("note.txt"), b"before").unwrap();
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        let expected = format!("{:x}", sha2::Sha256::digest(b"before"));
        atomic_write_workspace_file(root.to_str().unwrap(), "note.txt", b"after", &expected)
            .unwrap();
        assert_eq!(
            read_workspace_file(root.to_str().unwrap(), "note.txt").unwrap(),
            b"after"
        );
        symlink(outside.join("secret.txt"), root.join("file-link")).unwrap();
        symlink(&outside, root.join("dir-link")).unwrap();
        assert!(read_workspace_file(root.to_str().unwrap(), "file-link").is_err());
        assert!(read_workspace_file(root.to_str().unwrap(), "dir-link/secret.txt").is_err());
        assert!(
            atomic_write_workspace_file(root.to_str().unwrap(), "file-link", b"replace", "secret")
                .is_err()
        );
        assert!(read_workspace_file(root.to_str().unwrap(), "../outside/secret.txt").is_err());
        assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"secret");
        fs::remove_dir_all(temp).unwrap();
    }
}
