// Stored command output. Each call owns a directory under `data_dir/logs`
// with one data file and one chunk index per stream. Chunks are numbered from 0
// per stream; the index alone decides which bytes belong to a chunk, so a
// reader never sees a half-written chunk.
use crate::ledger::LogStream;
use serde_json::{Value, json};
use sha2::Digest;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tokio::sync::mpsc;

/// Largest chunk; its base64 form fits a `tool_log` frame.
pub const CHUNK_BYTES: usize = 16 * 1024;
/// Output stored per call across both streams. Bytes beyond it are still
/// drained from the pipes and counted, never stored.
pub const CALL_LOG_LIMIT: u64 = 10 * 1024 * 1024;
pub const STREAMS: [&str; 2] = ["stdout", "stderr"];

/// Buffers `docker inspect` stdout for redaction without exceeding the per-call log cap.
pub struct InspectStdoutHold {
    buffer: Vec<u8>,
    pub total: u64,
    pub truncated: bool,
    limit: usize,
}

impl InspectStdoutHold {
    pub fn new() -> Self {
        Self::with_limit(CALL_LOG_LIMIT as usize)
    }

    pub fn with_limit(limit: usize) -> Self {
        Self {
            buffer: Vec::new(),
            total: 0,
            truncated: false,
            limit,
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        let room = self.limit.saturating_sub(self.buffer.len());
        if room > 0 {
            let take = room.min(bytes.len());
            self.buffer.extend_from_slice(&bytes[..take]);
        }
        if bytes.len() > room {
            self.truncated = true;
        }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.buffer
    }
}
const INDEX_ENTRY: u64 = 16;

/// A stored chunk: sequence number, byte offset in its stream, data.
pub type StoredChunk = (u64, u64, Vec<u8>);

pub struct Chunk {
    pub job_id: String,
    pub call_id: String,
    pub stream: &'static str,
    pub seq: u64,
    pub offset: u64,
    pub data: Vec<u8>,
}

pub fn call_dir(root: &Path, call_id: &str) -> PathBuf {
    root.join(format!("{:x}", sha2::Sha256::digest(call_id.as_bytes())))
}

struct StreamFiles {
    data: File,
    index: File,
    chunks: u64,
    logged: u64,
    total: u64,
}

struct State {
    streams: Vec<StreamFiles>,
    logged: u64,
    truncated: bool,
    error: Option<String>,
}

/// Output of one running call. Appending never fails and never waits for the
/// connection: a full live queue only means the main node fetches later.
pub struct CallLog {
    job_id: String,
    call_id: String,
    live: mpsc::Sender<Chunk>,
    state: Mutex<State>,
}

impl CallLog {
    pub fn create(
        root: &Path,
        job_id: &str,
        call_id: &str,
        live: mpsc::Sender<Chunk>,
    ) -> std::io::Result<Self> {
        let dir = call_dir(root, call_id);
        fs::create_dir_all(&dir)?;
        let mut streams = Vec::new();
        for stream in STREAMS {
            let open = |name: String| {
                OpenOptions::new()
                    .create(true)
                    .truncate(true)
                    .write(true)
                    .open(dir.join(name))
            };
            streams.push(StreamFiles {
                data: open(format!("{stream}.log"))?,
                index: open(format!("{stream}.idx"))?,
                chunks: 0,
                logged: 0,
                total: 0,
            });
        }
        Ok(CallLog {
            job_id: job_id.to_owned(),
            call_id: call_id.to_owned(),
            live,
            state: Mutex::new(State {
                streams,
                logged: 0,
                truncated: false,
                error: None,
            }),
        })
    }

    pub fn append(&self, stream: usize, bytes: &[u8]) {
        let mut state = self.state.lock().unwrap();
        state.streams[stream].total += bytes.len() as u64;
        if state.error.is_some() {
            return;
        }
        let take = (CALL_LOG_LIMIT - state.logged).min(bytes.len() as u64) as usize;
        if take < bytes.len() {
            state.truncated = true;
        }
        if take == 0 {
            return;
        }
        let part = &bytes[..take];
        let files = &mut state.streams[stream];
        let (seq, offset) = (files.chunks, files.logged);
        let mut entry = [0u8; INDEX_ENTRY as usize];
        entry[..8].copy_from_slice(&offset.to_le_bytes());
        entry[8..].copy_from_slice(&(take as u64).to_le_bytes());
        // Data first, then the index entry that makes it visible.
        let written = files
            .data
            .write_all(part)
            .and_then(|_| files.index.write_all(&entry));
        if let Err(error) = written {
            state.truncated = true;
            state.error = Some(error.to_string());
            return;
        }
        files.chunks += 1;
        files.logged += take as u64;
        state.logged += take as u64;
        let _ = self.live.try_send(Chunk {
            job_id: self.job_id.clone(),
            call_id: self.call_id.clone(),
            stream: STREAMS[stream],
            seq,
            offset,
            data: part.to_vec(),
        });
    }

    /// Append in `CHUNK_BYTES`-sized pieces so live `tool_log` frames and `read` stay aligned.
    pub fn append_chunked(&self, stream: usize, bytes: &[u8]) {
        for part in bytes.chunks(CHUNK_BYTES) {
            self.append(stream, part);
        }
    }

    /// After a held inspect stdout is logged, record pipe totals and truncation.
    pub fn finish_inspect_stdout_hold(&self, stream: usize, bytes_total: u64, truncated: bool) {
        let mut state = self.state.lock().unwrap();
        state.streams[stream].total = bytes_total;
        if truncated {
            state.truncated = true;
        }
    }

    /// What the result reports about stored output, and the per-stream chunk
    /// counts the ledger keeps until the main node acknowledges them.
    pub fn summary(&self) -> (Value, Vec<LogStream>) {
        let state = self.state.lock().unwrap();
        let mut report = serde_json::Map::new();
        let mut streams = Vec::new();
        for (i, name) in STREAMS.iter().enumerate() {
            let s = &state.streams[i];
            report.insert(
                (*name).into(),
                json!({"bytes_total": s.total, "bytes_logged": s.logged, "chunks": s.chunks}),
            );
            streams.push(LogStream {
                stream: name,
                chunks: s.chunks,
            });
        }
        report.insert("truncated".into(), json!(state.truncated));
        report.insert("error".into(), json!(state.error));
        (Value::Object(report), streams)
    }
}

/// Chunks of a stream starting at `from_seq`, at most `max`, plus the number
/// of chunks stored. `None` when the output no longer exists.
pub fn read(
    root: &Path,
    call_id: &str,
    stream: &str,
    from_seq: u64,
    max: u64,
) -> std::io::Result<Option<(Vec<StoredChunk>, u64)>> {
    let dir = call_dir(root, call_id);
    let mut index = match File::open(dir.join(format!("{stream}.idx"))) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut data = File::open(dir.join(format!("{stream}.log")))?;
    let total = index.metadata()?.len() / INDEX_ENTRY;
    let mut chunks = Vec::new();
    let mut seq = from_seq;
    while seq < total && (chunks.len() as u64) < max {
        let mut entry = [0u8; INDEX_ENTRY as usize];
        index.seek(SeekFrom::Start(seq * INDEX_ENTRY))?;
        index.read_exact(&mut entry)?;
        let offset = u64::from_le_bytes(entry[..8].try_into().unwrap());
        let len = u64::from_le_bytes(entry[8..].try_into().unwrap()) as usize;
        let mut bytes = vec![0u8; len.min(CHUNK_BYTES)];
        data.seek(SeekFrom::Start(offset))?;
        data.read_exact(&mut bytes)?;
        chunks.push((seq, offset, bytes));
        seq += 1;
    }
    Ok(Some((chunks, total)))
}

pub fn remove(root: &Path, call_id: &str) {
    let _ = fs::remove_dir_all(call_dir(root, call_id));
}

/// Delete output no ledger record refers to any more.
pub fn prune(root: &Path, held: &[String]) -> std::io::Result<()> {
    let keep: HashSet<PathBuf> = held.iter().map(|id| call_dir(root, id)).collect();
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let path = entry?.path();
        if !keep.contains(&path) {
            let _ = fs::remove_dir_all(path);
        }
    }
    Ok(())
}

/// Bytes stored under the log root.
pub fn usage(root: &Path) -> u64 {
    let Ok(dirs) = fs::read_dir(root) else {
        return 0;
    };
    dirs.flatten()
        .filter_map(|d| fs::read_dir(d.path()).ok())
        .flat_map(|files| files.flatten())
        .filter_map(|f| f.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Space available to this process on the file system holding `path`.
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_round_trip_and_stop_at_the_call_limit() {
        let root = std::env::temp_dir().join(format!("worker-logs-{}", uuid::Uuid::new_v4()));
        let (tx, mut rx) = mpsc::channel(4);
        let log = CallLog::create(&root, "job", "call", tx).unwrap();
        log.append(0, b"hello ");
        log.append(0, b"world");
        log.append(1, b"oops");
        let (chunks, total) = read(&root, "call", "stdout", 1, 10).unwrap().unwrap();
        assert_eq!(total, 2);
        assert_eq!(chunks, vec![(1, 6, b"world".to_vec())]);
        assert_eq!(rx.try_recv().unwrap().data, b"hello ");
        // The live queue is bounded; overflow is dropped, never awaited.
        let big = vec![b'x'; CHUNK_BYTES];
        for _ in 0..(CALL_LOG_LIMIT as usize / CHUNK_BYTES + 3) {
            log.append(0, &big);
        }
        let (summary, streams) = log.summary();
        assert_eq!(summary["truncated"], json!(true));
        assert_eq!(
            summary["stdout"]["bytes_logged"].as_u64().unwrap() + 4,
            CALL_LOG_LIMIT
        );
        assert!(summary["stdout"]["bytes_total"].as_u64().unwrap() > CALL_LOG_LIMIT);
        assert_eq!(streams[1].chunks, 1);
        assert!(usage(&root) >= CALL_LOG_LIMIT);
        prune(&root, &[]).unwrap();
        assert!(read(&root, "call", "stdout", 0, 1).unwrap().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redacted_docker_inspect_larger_than_chunk_round_trips() {
        use crate::diagnosis;

        let filler = "z".repeat(CHUNK_BYTES + 4096);
        let raw = format!(
            r#"[{{"Config":{{"Env":["TOP_SECRET=leak"],"Image":"img"}},"Filler":"{filler}","State":{{"Status":"exited","ExitCode":42}}}}]"#
        );
        let redacted = diagnosis::redact_docker_inspect_stdout(&raw);
        assert!(redacted.len() > CHUNK_BYTES);
        assert!(!redacted.contains("TOP_SECRET"));

        let root = std::env::temp_dir().join(format!("worker-logs-{}", uuid::Uuid::new_v4()));
        let (tx, _rx) = mpsc::channel(4);
        let log = CallLog::create(&root, "job", "call", tx).unwrap();
        log.append_chunked(0, redacted.as_bytes());

        let (_, total) = read(&root, "call", "stdout", 0, 1).unwrap().unwrap();
        let (chunks, _) = read(&root, "call", "stdout", 0, total).unwrap().unwrap();
        for (_, _, data) in &chunks {
            assert!(data.len() <= CHUNK_BYTES);
        }
        let assembled: Vec<u8> = chunks.into_iter().flat_map(|(_, _, data)| data).collect();
        let text = String::from_utf8(assembled).unwrap();
        assert!(text.contains("\"ExitCode\":42"));
        assert!(text.contains("\"Status\":\"exited\""));
        assert!(!text.contains("TOP_SECRET"));
        assert!(text.contains("<redacted>"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn redacted_inspect_over_hold_cap_is_truncated_and_has_no_env_secrets() {
        use crate::diagnosis;

        const HOLD_CAP: usize = 64 * 1024;
        let filler = "y".repeat(HOLD_CAP + 32_768);
        let raw = format!(
            r#"[{{"Config":{{"Env":["CONTAINER_SECRET=leak"],"Image":"img"}},"Filler":"{filler}"}}]"#
        );
        let mut hold = InspectStdoutHold::with_limit(HOLD_CAP);
        hold.push(raw.as_bytes());
        assert!(hold.truncated);
        assert!(hold.total as usize > HOLD_CAP);

        let redacted =
            diagnosis::redact_docker_inspect_stdout(&String::from_utf8_lossy(hold.bytes()));
        assert!(!redacted.contains("CONTAINER_SECRET"));

        let root = std::env::temp_dir().join(format!("worker-logs-{}", uuid::Uuid::new_v4()));
        let (tx, _rx) = mpsc::channel(4);
        let log = CallLog::create(&root, "job", "call", tx).unwrap();
        log.append_chunked(0, redacted.as_bytes());
        log.finish_inspect_stdout_hold(0, hold.total, hold.truncated);

        let (summary, _) = log.summary();
        assert_eq!(summary["truncated"], json!(true));
        assert!(summary["stdout"]["bytes_total"].as_u64().unwrap() > HOLD_CAP as u64);
        let (_, total) = read(&root, "call", "stdout", 0, 1).unwrap().unwrap();
        let (chunks, _) = read(&root, "call", "stdout", 0, total).unwrap().unwrap();
        let text = String::from_utf8(chunks.into_iter().flat_map(|(_, _, d)| d).collect()).unwrap();
        assert!(!text.contains("CONTAINER_SECRET"));
        assert!(text.contains("<redacted>"));
        let _ = fs::remove_dir_all(root);
    }
}
