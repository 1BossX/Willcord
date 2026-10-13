// Controlled bash execution. Every command runs in its own process group; a
// timeout or cancel sends TERM to the group, KILL after the grace period, and
// counts the command as stopped only once the group is observed empty. A
// process that deliberately leaves the group (setsid) is outside this control.
use crate::diagnosis;
use crate::logs::{CHUNK_BYTES, CallLog};
use serde_json::{Value, json};
use std::{
    os::unix::process::ExitStatusExt,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::watch,
};

type Error = Box<dyn std::error::Error + Send + Sync>;

/// A partly filled chunk is stored after this much quiet time.
const FLUSH_DELAY: Duration = Duration::from_millis(200);
const POLL: Duration = Duration::from_millis(20);

pub struct Limits {
    /// Between TERM and KILL.
    pub grace: Duration,
    /// After KILL, and for pipes to close, before stopping is declared unconfirmed.
    pub confirm: Duration,
    /// PATH the command runs with.
    pub command_path: String,
}

pub enum Outcome {
    /// The command and its whole process group are gone.
    Finished(Value),
    /// The group could not be observed empty; execution state is unknown.
    Unconfirmed(Value),
}

fn group_alive(pgid: i32) -> bool {
    // EPERM still means a member exists.
    let probed = unsafe { libc::killpg(pgid, 0) };
    probed == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn signal_group(pgid: i32, signal: i32) {
    unsafe {
        libc::killpg(pgid, signal);
    }
}

/// Reap bash and wait until no member of its group remains.
async fn group_gone(child: &mut Child, pgid: i32, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        let reaped = matches!(child.try_wait(), Ok(Some(_)));
        if reaped && !group_alive(pgid) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// TERM, grace, KILL, confirm. Bash is not reaped before TERM is sent, so the
/// group ID cannot have been reused by an unrelated process.
async fn terminate(child: &mut Child, pgid: i32, limits: &Limits) -> bool {
    signal_group(pgid, libc::SIGTERM);
    crate::fault("after_term_sent");
    if group_gone(child, pgid, limits.grace).await {
        return true;
    }
    signal_group(pgid, libc::SIGKILL);
    group_gone(child, pgid, limits.confirm).await
}

/// Resolves when a stop is requested; never if the requester went away.
async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if cancel.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Copy one pipe into the call log until EOF. Reading never waits for the
/// connection, so a slow consumer cannot stall the command.
async fn drain(
    mut pipe: impl AsyncReadExt + Unpin,
    log: Arc<CallLog>,
    stream: usize,
    hold: Option<Arc<Mutex<Vec<u8>>>>,
) {
    let mut buffer = Vec::with_capacity(CHUNK_BYTES);
    let mut read = vec![0u8; CHUNK_BYTES];
    loop {
        let room = CHUNK_BYTES - buffer.len();
        let next = if buffer.is_empty() {
            pipe.read(&mut read[..room]).await
        } else {
            match tokio::time::timeout(FLUSH_DELAY, pipe.read(&mut read[..room])).await {
                Ok(next) => next,
                Err(_) => {
                    flush_drain_buffer(stream, &buffer, &log, &hold);
                    buffer.clear();
                    continue;
                }
            }
        };
        match next {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buffer.extend_from_slice(&read[..n]);
                if buffer.len() == CHUNK_BYTES {
                    flush_drain_buffer(stream, &buffer, &log, &hold);
                    buffer.clear();
                }
            }
        }
    }
    if !buffer.is_empty() {
        flush_drain_buffer(stream, &buffer, &log, &hold);
    }
}

fn flush_drain_buffer(
    stream: usize,
    buffer: &[u8],
    log: &Arc<CallLog>,
    hold: &Option<Arc<Mutex<Vec<u8>>>>,
) {
    if stream == 0 {
        if let Some(buf) = hold {
            buf.lock().unwrap().extend_from_slice(buffer);
            return;
        }
    }
    log.append(stream, buffer);
}

/// Run a program directly (no shell). Used in diagnosis mode after argv validation.
pub async fn run_direct(
    argv: &[String],
    cwd: &Path,
    timeout: Duration,
    cancel: watch::Receiver<bool>,
    log: Arc<CallLog>,
    limits: &Limits,
    redact_docker_inspect_stdout: bool,
) -> Result<Outcome, Error> {
    let program = argv.first().ok_or("empty argv")?.as_str();
    let hold_stdout = if redact_docker_inspect_stdout {
        Some(Arc::new(std::sync::Mutex::new(Vec::new())))
    } else {
        None
    };
    let started = Instant::now();
    let mut child = Command::new(program)
        .args(&argv[1..])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", &limits.command_path)
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn()?;
    run_child(
        &mut child,
        started,
        timeout,
        cancel,
        log,
        limits,
        hold_stdout,
        redact_docker_inspect_stdout,
    )
    .await
}

pub async fn run_bash(
    command: &str,
    cwd: &Path,
    timeout: Duration,
    cancel: watch::Receiver<bool>,
    log: Arc<CallLog>,
    limits: &Limits,
) -> Result<Outcome, Error> {
    let started = Instant::now();
    let mut child = Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-c", command])
        .current_dir(cwd)
        .env_clear()
        .env("PATH", &limits.command_path)
        .env("HOME", std::env::var("HOME").unwrap_or_default())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .process_group(0)
        .spawn()?;
    run_child(
        &mut child, started, timeout, cancel, log, limits, None, false,
    )
    .await
}

async fn run_child(
    child: &mut Child,
    started: Instant,
    timeout: Duration,
    cancel: watch::Receiver<bool>,
    log: Arc<CallLog>,
    limits: &Limits,
    hold_stdout: Option<Arc<Mutex<Vec<u8>>>>,
    redact_docker_inspect_stdout: bool,
) -> Result<Outcome, Error> {
    let pgid = child
        .id()
        .ok_or("process exited before its process group was known")? as i32;
    let stdout_hold = hold_stdout.clone();
    let readers = [
        tokio::spawn(drain(
            child.stdout.take().unwrap(),
            log.clone(),
            0,
            stdout_hold,
        )),
        tokio::spawn(drain(child.stderr.take().unwrap(), log.clone(), 1, None)),
    ];
    let mut termination = "exited";
    let exited = tokio::select! {
        status = child.wait() => { status?; true }
        _ = tokio::time::sleep(timeout) => { termination = "timeout"; false }
        _ = cancelled(cancel) => { termination = "cancelled"; false }
    };
    let leftover = exited && group_alive(pgid);
    let stopped = if !exited || leftover {
        terminate(child, pgid, limits).await
    } else {
        true
    };
    let mut pipes_closed = true;
    let deadline = Instant::now() + limits.confirm;
    for reader in readers {
        let left = deadline.saturating_duration_since(Instant::now());
        let abort = reader.abort_handle();
        if tokio::time::timeout(left, reader).await.is_err() {
            abort.abort();
            pipes_closed = false;
        }
    }
    if let Some(buf) = hold_stdout {
        let held = buf.lock().unwrap().clone();
        if !held.is_empty() {
            let out = if redact_docker_inspect_stdout {
                diagnosis::redact_docker_inspect_stdout(&String::from_utf8_lossy(&held))
                    .into_bytes()
            } else {
                held
            };
            log.append_chunked(0, &out);
        }
    }
    let (logs, _) = log.summary();
    let status = child.try_wait().ok().flatten();
    let report = json!({
        "exit_code": status.and_then(|s| s.code()),
        "signal": status.and_then(|s| s.signal()),
        "termination": termination,
        "leftover_terminated": leftover,
        "pipes_closed": pipes_closed,
        "duration_ms": started.elapsed().as_millis() as u64,
        "logs": logs,
    });
    if stopped {
        Ok(Outcome::Finished(report))
    } else {
        let mut evidence = report;
        evidence["error"] = json!("termination_unconfirmed");
        evidence["process_group"] = json!(pgid);
        Ok(Outcome::Unconfirmed(evidence))
    }
}

/// The bash time limit of a request: 600 s unless given, never above the
/// worker's cap. Anything else is refused before the ledger accepts the call.
pub fn bash_timeout(arguments: &Value, cap_secs: u64) -> Result<Duration, &'static str> {
    match arguments.get("timeout_secs") {
        None => Ok(Duration::from_secs(600.min(cap_secs))),
        Some(value) => match value.as_u64() {
            Some(secs) if (1..=cap_secs).contains(&secs) => Ok(Duration::from_secs(secs)),
            _ => Err("invalid"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("worker-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn limits() -> Limits {
        Limits {
            grace: Duration::from_millis(500),
            confirm: Duration::from_secs(3),
            command_path: "/usr/local/bin:/usr/bin:/bin".to_string(),
        }
    }

    async fn run(
        command: &str,
        timeout: Duration,
        cancel_after: Option<Duration>,
    ) -> (Value, std::path::PathBuf) {
        let dir = temp();
        let (live, _rx) = tokio::sync::mpsc::channel(1);
        let log = Arc::new(CallLog::create(&dir.join("logs"), "job", "call", live).unwrap());
        let (stop, cancel) = watch::channel(false);
        if let Some(after) = cancel_after {
            tokio::spawn(async move {
                tokio::time::sleep(after).await;
                let _ = stop.send(true);
            });
        } else {
            std::mem::forget(stop);
        }
        match run_bash(command, &dir, timeout, cancel, log, &limits())
            .await
            .unwrap()
        {
            Outcome::Finished(report) => (report, dir),
            Outcome::Unconfirmed(report) => panic!("unconfirmed: {report}"),
        }
    }

    #[tokio::test]
    async fn cancel_escalates_to_kill_and_stops_the_whole_group() {
        // The shell ignores TERM; its background child writes a pid file.
        let (report, dir) = run(
            "trap '' TERM; sleep 30 & echo $! > child.pid; wait",
            Duration::from_secs(30),
            Some(Duration::from_millis(300)),
        )
        .await;
        assert_eq!(report["termination"], "cancelled");
        assert_eq!(report["signal"], libc::SIGKILL);
        let pid: i32 = std::fs::read_to_string(dir.join("child.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(unsafe { libc::kill(pid, 0) } != 0, "group member survived");
        assert!(report["duration_ms"].as_u64().unwrap() >= 800);
    }

    #[tokio::test]
    async fn timeout_terms_a_cooperative_command() {
        let (report, _) = run("sleep 30", Duration::from_millis(300), None).await;
        assert_eq!(report["termination"], "timeout");
        assert_eq!(report["signal"], libc::SIGTERM);
    }

    #[tokio::test]
    async fn finished_command_reports_exit_and_stops_leftovers() {
        let (report, _) = run("echo out; echo err >&2; (sleep 30 >/dev/null 2>&1 &); sleep 30 >/dev/null 2>&1 & exit 3", Duration::from_secs(10), None).await;
        assert_eq!(report["termination"], "exited");
        assert_eq!(report["exit_code"], 3);
        assert_eq!(report["leftover_terminated"], true);
        assert_eq!(report["logs"]["stdout"]["bytes_total"], 4);
        assert_eq!(report["logs"]["stderr"]["bytes_total"], 4);
    }

    #[tokio::test]
    async fn large_output_is_drained_and_truncated() {
        let (report, _) = run(
            "head -c 31457280 /dev/zero; echo done >&2",
            Duration::from_secs(60),
            None,
        )
        .await;
        assert_eq!(report["exit_code"], 0);
        assert_eq!(report["logs"]["stdout"]["bytes_total"], 31457280);
        assert_eq!(report["logs"]["truncated"], true);
        let logged = report["logs"]["stdout"]["bytes_logged"].as_u64().unwrap()
            + report["logs"]["stderr"]["bytes_logged"].as_u64().unwrap();
        assert_eq!(logged, crate::logs::CALL_LOG_LIMIT);
    }

    #[test]
    fn timeout_argument_is_bounded() {
        assert_eq!(bash_timeout(&json!({}), 1800), Ok(Duration::from_secs(600)));
        assert_eq!(
            bash_timeout(&json!({"timeout_secs": 2}), 1800),
            Ok(Duration::from_secs(2))
        );
        assert_eq!(
            bash_timeout(&json!({"timeout_secs": 1801}), 1800),
            Err("invalid")
        );
        assert_eq!(
            bash_timeout(&json!({"timeout_secs": 0}), 1800),
            Err("invalid")
        );
        assert_eq!(
            bash_timeout(&json!({"timeout_secs": "9"}), 1800),
            Err("invalid")
        );
        assert_eq!(
            bash_timeout(&json!({"timeout_secs": 900}), 600),
            Err("invalid")
        );
        assert_eq!(bash_timeout(&json!({}), 300), Ok(Duration::from_secs(300)));
    }
}
