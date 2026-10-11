use crate::{Config, Error};
use base64::{Engine as _, engine::general_purpose::STANDARD as B64};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
// sudo drops SSL_CERT_FILE, so system commands take the CA saved at install.
static SYSTEM_CA: OnceLock<PathBuf> = OnceLock::new();
// A boot-time service: a root-owned install root holds the binary and
// system.json; data/ belongs to the account every command runs as.
pub struct System {
    root: PathBuf,
    user: String,
    uid: u32,
    gid: u32,
    home: PathBuf,
    ca: Option<PathBuf>,
}
impl System {
    fn data(&self) -> PathBuf {
        self.root.join("data")
    }
}
fn system_root() -> Result<PathBuf, Error> {
    if let Some(p) = std::env::var_os("WORKER_PLANE_SYSTEM_ROOT") {
        let path = PathBuf::from(p);
        if !path.is_absolute() || path == Path::new("/") {
            return Err("WORKER_PLANE_SYSTEM_ROOT must be an absolute directory".into());
        }
        return Ok(path);
    }
    Ok(PathBuf::from(if cfg!(target_os = "macos") {
        "/Library/Application Support/WorkerPlane"
    } else {
        "/var/lib/worker-plane-system"
    }))
}
fn valid_user(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn lookup(user: &str) -> Result<(u32, u32, PathBuf), Error> {
    if !valid_user(user) {
        return Err("invalid account name".into());
    }
    let name = std::ffi::CString::new(user)?;
    let pw = unsafe { libc::getpwnam(name.as_ptr()) };
    if pw.is_null() {
        return Err(format!("account {user} does not exist; create it first").into());
    }
    let (uid, gid) = unsafe { ((*pw).pw_uid, (*pw).pw_gid) };
    if uid == 0 {
        return Err("the service account must not be root".into());
    }
    let home = unsafe { std::ffi::CStr::from_ptr((*pw).pw_dir) };
    use std::os::unix::ffi::OsStrExt;
    Ok((
        uid,
        gid,
        PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())),
    ))
}
fn read_system(root: &Path) -> Result<System, Error> {
    let path = root.join("system.json");
    let meta = fs::metadata(&path).map_err(|_| "no system install; run install --system first")?;
    use std::os::unix::fs::MetadataExt;
    for m in [&meta, &fs::metadata(root)?] {
        if m.uid() != 0 || m.mode() & 0o022 != 0 {
            return Err("system install must be owned by root and not writable by others".into());
        }
    }
    let v: Value = serde_json::from_slice(&fs::read(path)?)?;
    let user = v["user"]
        .as_str()
        .ok_or("system.json: missing user")?
        .to_owned();
    let (uid, gid, home) = lookup(&user)?;
    Ok(System {
        root: root.to_owned(),
        user,
        uid,
        gid,
        home,
        ca: v["ca"].as_str().map(PathBuf::from),
    })
}
// join, status and workspace write identity and lock files; they must be
// created by the service account, never by root.
fn become_service_user(sys: &System) -> Result<(), Error> {
    let euid = unsafe { libc::geteuid() };
    if euid == sys.uid {
        return Ok(());
    }
    if euid != 0 {
        return Err(format!("run with sudo or as {}", sys.user).into());
    }
    let gid = sys.gid as libc::gid_t;
    let name = std::ffi::CString::new(sys.user.as_str())?;
    unsafe {
        // The account's supplementary groups too, as systemd User= and
        // launchd UserName grant them to the service.
        if libc::initgroups(name.as_ptr(), gid as _) != 0
            || libc::setgid(gid) != 0
            || libc::setuid(sys.uid as libc::uid_t) != 0
        {
            return Err("could not switch to the service account".into());
        }
        if libc::geteuid() != sys.uid || libc::setuid(0) == 0 {
            return Err("could not drop root privileges".into());
        }
    }
    Ok(())
}
pub fn root() -> Result<PathBuf, Error> {
    if let Some(p) = std::env::var_os("WORKER_PLANE_HOME") {
        let path = PathBuf::from(p);
        if !path.is_absolute()
            || path == Path::new("/")
            || std::env::var_os("HOME").is_some_and(|h| path == PathBuf::from(h))
        {
            return Err(
                "WORKER_PLANE_HOME must be an absolute private application directory".into(),
            );
        }
        return Ok(path);
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME required")?);
    Ok(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/WorkerPlane")
    } else {
        home.join(".local/share/worker-plane")
    })
}
pub fn private_dir(p: &Path) -> Result<(), Error> {
    fs::create_dir_all(p)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
pub fn save(p: &Path, bytes: &[u8]) -> Result<(), Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = p.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    fs::rename(tmp, p)?;
    fs::File::open(p.parent().ok_or("missing parent")?)?.sync_all()?;
    Ok(())
}
pub fn record_status(dir: &Path, error: Option<String>) {
    if dir.join("enrollment.json").exists() {
        if let Ok(bytes) = serde_json::to_vec(&json!({"last_error": error})) {
            let _ = save(&dir.join("runtime-status.json"), &bytes);
        }
    }
}
fn identity(dir: &Path) -> Result<Ed25519KeyPair, Error> {
    use fs2::FileExt;
    use std::os::unix::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(dir.join("identity.lock"))?;
    lock.lock_exclusive()?;
    let p = dir.join("identity.pk8");
    if !p.exists() {
        let doc = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| "key generation failed")?;
        save(&p, doc.as_ref())?;
    }
    use std::os::unix::fs::PermissionsExt;
    if fs::metadata(&p)?.permissions().mode() & 0o077 != 0 {
        return Err("device private key must be readable only by its owner".into());
    }
    Ed25519KeyPair::from_pkcs8(&fs::read(p)?).map_err(|_| "invalid device identity".into())
}
fn public(key: &Ed25519KeyPair) -> Vec<u8> {
    let mut der = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    ];
    der.extend_from_slice(key.public_key().as_ref());
    der
}
// Existing user installs may still point to an external CA file.
fn user_ca(dir: &Path) -> Option<PathBuf> {
    let copy = dir.join("ca.pem");
    if copy.is_file() {
        Some(copy)
    } else {
        fs::read_to_string(dir.join("service-ca"))
            .ok()
            .map(PathBuf::from)
    }
}
fn copy_user_ca(dir: &Path, explicit: Option<PathBuf>) -> Result<(), Error> {
    let source = explicit.or_else(|| user_ca(dir));
    if let Some(source) = source {
        let pem = fs::read(source)?;
        if reqwest::Certificate::from_pem_bundle(&pem)?.is_empty() {
            return Err("CA bundle contains no certificates".into());
        }
        let copy = dir.join("ca.pem");
        save(&copy, &pem)?;
        save(&dir.join("service-ca"), copy.to_string_lossy().as_bytes())?;
    }
    Ok(())
}
fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}
async fn client() -> Result<reqwest::Client, Error> {
    let mut b = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15));
    let ca = std::env::var_os("SSL_CERT_FILE")
        .map(PathBuf::from)
        .or_else(|| SYSTEM_CA.get().cloned());
    if let Some(p) = ca {
        for cert in reqwest::Certificate::from_pem_bundle(&fs::read(p)?)? {
            b = b.add_root_certificate(cert);
        }
    }
    Ok(b.build()?)
}
pub async fn proof(dir: &Path, action: &str) -> Result<Value, Error> {
    let meta: Value = serde_json::from_slice(&fs::read(dir.join("enrollment.json"))?)?;
    let base = meta["url"].as_str().ok_or("missing URL")?;
    if !dir.join("identity.pk8").exists() {
        return Err("device identity lost; revoke the old device before recovery".into());
    }
    let key = identity(dir)?;
    let public_key = B64.encode(public(&key));
    let c = client().await?;
    let challenge: Value = c
        .post(format!("{base}/enrollment/challenge"))
        .json(&json!({}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let payload = json!([
        "workerplane-enrollment-v1",
        action,
        challenge["challenge"],
        public_key,
        if action == "apply" {
            meta["name"].clone()
        } else {
            Value::Null
        },
        if action == "apply" {
            json!(std::env::consts::OS)
        } else {
            Value::Null
        },
        if action == "apply" {
            json!(std::env::consts::ARCH)
        } else {
            Value::Null
        }
    ]);
    let body = json!({"public_key":public_key,"challenge":challenge["challenge"],"signature":B64.encode(key.sign(serde_json::to_string(&payload)?.as_bytes()).as_ref()),"name":meta["name"],"os":std::env::consts::OS,"arch":std::env::consts::ARCH});
    let response = c
        .post(format!("{base}/enrollment/{action}"))
        .json(&body)
        .send()
        .await?;
    let status = response.status();
    let data: Value = response.json().await?;
    if !status.is_success() {
        return Err(format!(
            "enrollment: {}",
            data["error"].as_str().unwrap_or("request failed")
        )
        .into());
    }
    Ok(data)
}
fn setup(dir: &Path, base: &str) -> Result<(), Error> {
    let key = identity(dir)?;
    let id = format!("{:x}", Sha256::digest(public(&key)));
    private_dir(&dir.join("workspaces/default"))?;
    let config = json!({"worker_id":id,"data_dir":dir,"url":format!("{}/ws/worker",base.replacen("https:","wss:",1)),"token_file":dir.join("token"),"workspaces":[{"workspace_id":"default","config_version":1,"path":dir.join("workspaces/default"),"repo_id":"local/default","is_default":true}]});
    if !dir.join("worker.toml").exists() {
        save(
            &dir.join("worker.toml"),
            toml::to_string_pretty(&config)?.as_bytes(),
        )?;
    }
    Ok(())
}
fn service_name(dir: &Path) -> String {
    let suffix = format!("{:x}", Sha256::digest(dir.as_os_str().as_encoded_bytes()));
    if cfg!(target_os = "macos") {
        format!("org.workerplane.worker.{}", &suffix[..12])
    } else {
        format!("worker-plane-{}", &suffix[..12])
    }
}
fn worker_running(dir: &Path) -> bool {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join("worker.lock"))
        .ok()
        .map(|f| fs2::FileExt::try_lock_exclusive(&f).is_err())
        .unwrap_or(false)
}
fn launchd_domain(sys: Option<&System>) -> String {
    match sys {
        Some(_) => "system".into(),
        None => format!("gui/{}", unsafe { libc::getuid() }),
    }
}
fn service_running(dir: &Path, sys: Option<&System>) -> bool {
    let name = service_name(dir);
    if cfg!(target_os = "macos") {
        Command::new("launchctl")
            .args(["print", &format!("{}/{name}", launchd_domain(sys))])
            .output()
            .is_ok_and(|o| o.status.success())
    } else {
        let mut c = Command::new("systemctl");
        if sys.is_none() {
            c.arg("--user");
        }
        c.args(["is-active", &format!("{name}.service")])
            .output()
            .is_ok_and(|o| o.status.success())
    }
}
fn wait_stopped(dir: &Path, sys: Option<&System>) -> Result<(), Error> {
    for _ in 0..300 {
        if !service_running(dir, sys) && !worker_running(dir) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("service is still running; operation stopped before data removal".into())
}
fn xml(p: &Path) -> String {
    p.to_string_lossy()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn unit_quote(p: &Path) -> String {
    p.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('%', "%%")
}
fn launchd_plist(
    name: &str,
    exe: &Path,
    dir: &Path,
    ca: Option<&Path>,
    user: Option<(&str, &Path)>,
) -> String {
    // A LaunchDaemon also gets the stop grace of deploy/launchd: SIGTERM
    // cancels running commands before launchd kills the job.
    let daemon = user
        .map(|(u, _)| format!("<key>UserName</key><string>{u}</string><key>ExitTimeOut</key><integer>60</integer><key>ThrottleInterval</key><integer>60</integer><key>Umask</key><integer>63</integer>"))
        .unwrap_or_default();
    format!(
        "<?xml version=\"1.0\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{name}</string>{daemon}<key>ProgramArguments</key><array><string>{}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>WORKER_PLANE_HOME</key><string>{}</string>{}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>{}</string></dict></plist>",
        xml(exe),
        xml(dir),
        // launchd sets no HOME for daemons; commands need the account's.
        user.map(|(_, h)| format!("<key>HOME</key><string>{}</string>", xml(h)))
            .unwrap_or_default()
            + &ca
                .map(|p| format!("<key>SSL_CERT_FILE</key><string>{}</string>", xml(p)))
                .unwrap_or_default(),
        xml(&dir.join("service.log"))
    )
}
fn systemd_unit(exe: &Path, dir: &Path, ca: Option<&Path>, user: Option<&str>) -> String {
    let ca = ca
        .map(|p| format!("Environment=\"SSL_CERT_FILE={}\"\n", unit_quote(p)))
        .unwrap_or_default();
    match user {
        None => format!(
            "[Unit]\nDescription=WorkerPlane worker\n[Service]\nExecStart=\"{}\" run\nEnvironment=\"WORKER_PLANE_HOME={}\"\n{ca}Restart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n",
            unit_quote(exe),
            unit_quote(dir)
        ),
        // Mirrors deploy/systemd/worker-plane-worker.service.
        Some(u) => format!(
            "[Unit]\nDescription=WorkerPlane worker\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser={u}\nExecStart=\"{}\" run\nEnvironment=\"WORKER_PLANE_HOME={}\"\n{ca}KillSignal=SIGTERM\nTimeoutStopSec=60\nKillMode=control-group\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n",
            unit_quote(exe),
            unit_quote(dir)
        ),
    }
}
// Service definitions are read by launchd/systemd, not the worker: 0644.
fn save_public(p: &Path, bytes: &[u8]) -> Result<(), Error> {
    save(p, bytes)?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(p, fs::Permissions::from_mode(0o644))?;
    Ok(())
}
fn service(dir: &Path, sys: Option<&System>, install: bool) -> Result<(), Error> {
    let name = service_name(dir);
    let exe = match sys {
        Some(s) => s.root.join("bin/worker"),
        None => dir.join("bin/worker"),
    };
    let ca = match sys {
        Some(s) => s.ca.clone(),
        None => user_ca(dir),
    };
    let user = sys.map(|s| s.user.as_str());
    if cfg!(target_os = "macos") {
        let directory = match sys {
            Some(_) => PathBuf::from("/Library/LaunchDaemons"),
            None => std::env::var_os("WORKER_PLANE_LAUNCH_AGENT_DIR")
                .map(PathBuf::from)
                .map_or_else(
                    || {
                        std::env::var_os("HOME")
                            .map(|h| PathBuf::from(h).join("Library/LaunchAgents"))
                            .ok_or("HOME required")
                    },
                    Ok,
                )?,
        };
        if !directory.is_absolute() {
            return Err("LaunchAgent directory must be absolute".into());
        }
        let path = directory.join(format!("{name}.plist"));
        let domain = launchd_domain(sys);
        if install {
            fs::create_dir_all(&directory)?;
            let plist = launchd_plist(
                &name,
                &exe,
                dir,
                ca.as_deref(),
                sys.map(|s| (s.user.as_str(), s.home.as_path())),
            );
            if sys.is_some() {
                save_public(&path, plist.as_bytes())?;
            } else {
                save(&path, plist.as_bytes())?;
            }
            let _ = Command::new("launchctl")
                .args(["bootout", &domain])
                .arg(&path)
                .output();
            wait_stopped(dir, sys)?;
            if !Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(path)
                .status()?
                .success()
            {
                return Err("launchctl bootstrap failed".into());
            }
        } else {
            let _ = Command::new("launchctl")
                .args(["bootout", &format!("{domain}/{name}")])
                .output();
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    } else {
        let path = match sys {
            Some(_) => PathBuf::from(format!("/etc/systemd/system/{name}.service")),
            None => PathBuf::from(std::env::var_os("HOME").ok_or("HOME required")?)
                .join(format!(".config/systemd/user/{name}.service")),
        };
        let scope: &[&str] = if sys.is_some() { &[] } else { &["--user"] };
        let unit = format!("{name}.service");
        if install {
            fs::create_dir_all(path.parent().unwrap())?;
            let text = systemd_unit(&exe, dir, ca.as_deref(), user);
            if sys.is_some() {
                save_public(&path, text.as_bytes())?;
            } else {
                save(&path, text.as_bytes())?;
            }
            for args in [
                &["daemon-reload"][..],
                &["enable", &unit][..],
                &["restart", &unit][..],
            ] {
                if !Command::new("systemctl")
                    .args(scope)
                    .args(args)
                    .status()?
                    .success()
                {
                    return Err(if sys.is_some() {
                        "systemctl failed".into()
                    } else {
                        "systemctl failed; a user session is required".into()
                    });
                }
            }
        } else {
            let _ = Command::new("systemctl")
                .args(scope)
                .args(["disable", "--now", &unit])
                .output();
            if path.exists() {
                fs::remove_file(path)?;
            }
            let _ = Command::new("systemctl")
                .args(scope)
                .arg("daemon-reload")
                .output();
        }
    }
    if !install {
        wait_stopped(dir, sys)?;
    }
    Ok(())
}
fn install_system(root: &Path, user: Option<&str>) -> Result<System, Error> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("install --system must run as root (sudo)".into());
    }
    let user = user
        .ok_or("install --system requires --user ACCOUNT, the existing account commands run as")?;
    let (uid, gid, home) = lookup(user)?;
    let old = root
        .join("system.json")
        .exists()
        .then(|| read_system(root))
        .transpose()?;
    if let Some(old) = &old {
        if old.user != user {
            return Err(format!(
                "this system install runs as {}; uninstall it before changing the account",
                old.user
            )
            .into());
        }
    }
    use std::os::unix::fs::PermissionsExt;
    for d in [root.to_owned(), root.join("bin")] {
        fs::create_dir_all(&d)?;
        std::os::unix::fs::chown(&d, Some(0), Some(0))?;
        fs::set_permissions(&d, fs::Permissions::from_mode(0o755))?;
    }
    // Root can read a CA the service account cannot (under /root or a 0700
    // home), so keep a public copy inside the install root.
    let ca = match std::env::var_os("SSL_CERT_FILE") {
        Some(p) => {
            let pem = fs::read(p)?;
            let copy = root.join("ca.pem");
            save_public(&copy, &pem)?;
            Some(copy)
        }
        None => old.and_then(|o| o.ca),
    };
    let sys = System {
        root: root.to_owned(),
        user: user.to_owned(),
        uid,
        gid,
        home,
        ca,
    };
    private_dir(&sys.data())?;
    std::os::unix::fs::chown(sys.data(), Some(uid), Some(gid))?;
    save_public(
        &root.join("system.json"),
        serde_json::to_string(&json!({"user": user, "ca": sys.ca}))?.as_bytes(),
    )?;
    Ok(sys)
}
/// The machine's own name, so the console shows "my-laptop" rather than a
/// generic "worker". HOSTNAME is a shell variable that is usually not exported.
fn device_name() -> String {
    let mut buf = [0u8; 256];
    let from_os = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len() - 1) } == 0;
    let host = if from_os {
        String::from_utf8_lossy(&buf[..buf.iter().position(|b| *b == 0).unwrap_or(buf.len())])
            .into_owned()
    } else {
        String::new()
    };
    normalize_device_name(&host, std::env::var("HOSTNAME").ok().as_deref())
}
fn normalize_device_name(host: &str, env: Option<&str>) -> String {
    for candidate in [host, env.unwrap_or("")] {
        let name = candidate.trim().trim_end_matches(".local").trim();
        let name: String = name.chars().filter(|c| !c.is_control()).take(128).collect();
        if !name.is_empty() {
            return name;
        }
    }
    "worker".into()
}
/// What `join` tells the person: an already approved machine has nothing left to approve.
fn join_summary(state: &Value, fingerprint: &str, base: &str) -> String {
    let authorization = state["state"].as_str().unwrap_or("unknown");
    let next = match authorization {
        "approved" => "本机已获授权，无需再次批准；等待控制台显示“可执行”后即可使用。",
        "pending" => "核对控制台指纹后批准；等待机器显示可执行，再验证只读任务。",
        "rejected" | "revoked" => "此机器的授权已被拒绝或撤销；如需恢复，请在控制台重新批准。",
        _ => "请在控制台查看本机的授权状态。",
    };
    format!(
        "Node: {}\nFingerprint (SHA-256 of public key): {fingerprint}\nAuthorization: {authorization}\nConsole: {base}\nNext: {next}",
        state["worker_id"].as_str().unwrap_or("unknown"),
    )
}
const USAGE: &str = "usage: worker install [--system --user ACCOUNT] | join URL | status [--json] | workspace add ID PATH | workspace list | run | uninstall [--delete-data]  (add --system to manage the system service)";
/// A mistyped command is not a failure with a backtrace-style message: say so plainly and exit.
fn usage_error(command: Option<&str>) -> ! {
    if let Some(command) = command {
        eprintln!("worker: unknown command '{command}'");
    }
    eprintln!("{USAGE}");
    std::process::exit(2)
}
const COMMANDS: [&str; 6] = ["install", "join", "status", "workspace", "run", "uninstall"];
/// What the first argument means: a command, a request for help, or the legacy
/// config-file path. Anything else is a typo, not a file to open.
#[derive(Debug, PartialEq)]
enum Route {
    Command,
    Help,
    ConfigFile,
    Unknown,
}
fn route(first: &str, is_file: bool) -> Route {
    if COMMANDS.contains(&first) {
        Route::Command
    } else if ["-h", "--help", "help"].contains(&first) {
        Route::Help
    } else if is_file {
        Route::ConfigFile
    } else {
        Route::Unknown
    }
}
pub async fn dispatch() -> Result<Option<PathBuf>, Error> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().cloned() else {
        usage_error(None);
    };
    let command = command.as_str();
    match route(command, Path::new(command).is_file()) {
        Route::Command => {}
        Route::Help => {
            println!("{USAGE}");
            return Ok(None);
        }
        Route::ConfigFile => return Ok(Some(PathBuf::from(command))),
        Route::Unknown => usage_error(Some(command)),
    }
    let system = take_flag(&mut args, "--system");
    let account = take_value(&mut args, "--user")?;
    if account.is_some() && !(system && command == "install") {
        return Err("--user only applies to install --system".into());
    }
    if system && command == "run" {
        return Err("run takes WORKER_PLANE_HOME from the service definition".into());
    }
    let sys = if !system {
        None
    } else if command == "install" {
        Some(install_system(&system_root()?, account.as_deref())?)
    } else {
        Some(read_system(&system_root()?)?)
    };
    if let Some(ca) = sys.as_ref().and_then(|s| s.ca.clone()) {
        let _ = SYSTEM_CA.set(ca);
    }
    let dir = match &sys {
        Some(s) => {
            if !["install", "uninstall"].contains(&command) {
                become_service_user(s)?;
            } else if unsafe { libc::geteuid() } != 0 {
                return Err(format!("{command} --system must run as root (sudo)").into());
            }
            s.data()
        }
        None => {
            if command == "install" && unsafe { libc::geteuid() } == 0 {
                return Err("install as root needs --system --user ACCOUNT; run without sudo for a per-user service".into());
            }
            let dir = root()?;
            private_dir(&dir)?;
            dir
        }
    };
    if sys.is_none() {
        if let Some(ca) = user_ca(&dir) {
            let _ = SYSTEM_CA.set(ca);
        }
    }
    let sys = sys.as_ref();
    match command {
        "install" => {
            if worker_running(&dir) {
                proof(&dir, "workspace").await?;
            }
            use std::os::unix::fs::PermissionsExt;
            let (target, mode) = match sys {
                Some(s) => (s.root.join("bin/worker"), 0o755),
                None => {
                    copy_user_ca(&dir, std::env::var_os("SSL_CERT_FILE").map(PathBuf::from))?;
                    private_dir(&dir.join("bin"))?;
                    (dir.join("bin/worker"), 0o700)
                }
            };
            let current = std::env::current_exe()?;
            if current != target {
                save(&target, &fs::read(current)?)?;
                fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
            }
            let marker = sys.map_or_else(|| dir.clone(), |s| s.root.clone());
            if sys.is_some() {
                save_public(&marker.join("managed-install"), b"worker-plane-managed-v1")?;
            } else {
                save(&marker.join("managed-install"), b"worker-plane-managed-v1")?;
            }
            service(&dir, sys, true)?;
            println!("Service: {}", service_name(&dir));
            // enrollment.json is written before the request is sent, so it proves an
            // attempt, not an accepted one: always point at `join` for the real state.
            let attempted = dir.join("enrollment.json").exists();
            match sys {
                Some(s) => println!(
                    "Installed as a system service running as {}. Next: sudo {} join --system <server-https-origin>{}",
                    s.user,
                    shell_quote(&target),
                    if attempted {
                        " (a join was already attempted; this shows its current state)"
                    } else {
                        ""
                    }
                ),
                None => println!(
                    "Installed. Next: {} join <server-https-origin>{}",
                    shell_quote(&target),
                    if attempted {
                        " (a join was already attempted; this shows its current state)"
                    } else {
                        ""
                    }
                ),
            }
        }
        "join" => {
            let url = reqwest::Url::parse(args.get(1).ok_or("join requires HTTPS URL")?)?;
            if url.scheme() != "https"
                || url.host_str().is_none()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("join requires an HTTPS origin".into());
            }
            let base = url.as_str().trim_end_matches('/');
            if dir.join("enrollment.json").exists() {
                if !dir.join("identity.pk8").exists() {
                    return Err(
                        "device identity lost; revoke the old device before recovery".into(),
                    );
                }
                let old: Value = serde_json::from_slice(&fs::read(dir.join("enrollment.json"))?)?;
                if old["url"] != base {
                    return Err("device is already bound to another server".into());
                }
            } else {
                identity(&dir)?;
                save(
                    &dir.join("enrollment.json"),
                    serde_json::to_string(&json!({"url":base,"name":device_name()}))?.as_bytes(),
                )?;
            }
            setup(&dir, base)?;
            let state = proof(&dir, "apply").await?;
            println!(
                "{}",
                join_summary(
                    &state,
                    &format!("{:x}", Sha256::digest(public(&identity(&dir)?))),
                    base
                )
            );
        }
        "run" => {
            let mut last_message = String::new();
            loop {
                if dir.join("enrollment.json").exists() {
                    match proof(&dir, "status").await {
                        Ok(state) if state["state"] == "approved" => {
                            if !dir.join("token").exists() {
                                let credential = proof(&dir, "credentials").await?;
                                save(
                                    &dir.join("token"),
                                    credential["token"]
                                        .as_str()
                                        .ok_or("missing token")?
                                        .as_bytes(),
                                )?;
                            }
                            return Ok(Some(dir.join("worker.toml")));
                        }
                        Ok(state) => {
                            let message = format!("Authorization: {}", state["state"]);
                            if message != last_message {
                                eprintln!("{message}");
                                last_message = message;
                            }
                        }
                        Err(e) => {
                            let message = e.to_string();
                            if message != last_message {
                                eprintln!("{message}");
                                last_message = message;
                            }
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
        "status" => {
            let mut state = if dir.join("enrollment.json").exists() {
                proof(&dir, "status")
                    .await
                    .unwrap_or_else(|e| json!({"last_error":e.to_string()}))
            } else {
                json!({"state":"not_joined"})
            };
            if state.get("last_error").is_none() {
                if let Ok(bytes) = fs::read(dir.join("runtime-status.json")) {
                    if let Ok(local) = serde_json::from_slice::<Value>(&bytes) {
                        state["last_error"] = local["last_error"].clone();
                    }
                }
            }
            if state.get("last_error").is_none() {
                state["last_error"] = Value::Null;
            }
            if state.get("worker_id").is_none() {
                if let Ok(text) = fs::read_to_string(dir.join("worker.toml")) {
                    if let Ok(config) = toml::from_str::<Config>(&text) {
                        state["worker_id"] = json!(config.worker_id);
                    }
                }
            }
            state["data_dir"] = json!(dir);
            state["default_directory"] = json!(dir.join("workspaces/default"));
            let running = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(dir.join("worker.lock"))
                .ok()
                .map(|f| fs2::FileExt::try_lock_exclusive(&f).is_err())
                .unwrap_or(false);
            state["worker_running"] = json!(running);
            state["service_running"] = json!(service_running(&dir, sys));
            state["service_name"] = json!(service_name(&dir));
            state["service_scope"] = json!(if sys.is_some() { "system" } else { "user" });
            if let Some(s) = sys {
                state["service_account"] = json!(s.user);
            }
            if dir.join("enrollment.json").exists() {
                let m: Value = serde_json::from_slice(&fs::read(dir.join("enrollment.json"))?)?;
                state["server"] = m["url"].clone();
            }
            println!("{}", serde_json::to_string_pretty(&state)?);
        }
        "workspace" => {
            let cfg: Config = toml::from_str(&fs::read_to_string(dir.join("worker.toml"))?)?;
            if args.get(1).map(String::as_str) == Some("list") {
                println!("{}", serde_json::to_string_pretty(&cfg.workspaces)?);
            } else if args.get(1).map(String::as_str) == Some("add") {
                let id = args.get(2).ok_or("workspace ID required")?;
                let path = PathBuf::from(args.get(3).ok_or("workspace path required")?);
                if id.is_empty()
                    || id.len() > 128
                    || !path.is_absolute()
                    || !path.is_dir()
                    || cfg.workspaces.iter().any(|w| w.workspace_id == *id)
                {
                    return Err("invalid or duplicate workspace".into());
                }
                let mut socket = tokio::net::UnixStream::connect(dir.join("control.sock"))
                    .await
                    .map_err(|_| "worker must be running to change workspaces safely")?;
                socket
                    .write_all(format!("{}\n", json!({"workspace_id":id,"path":path})).as_bytes())
                    .await?;
                let mut line = String::new();
                BufReader::new(socket).read_line(&mut line).await?;
                if line.trim() != "ok" {
                    return Err(line.into());
                }
                println!("Workspace added");
            } else {
                return Err("usage: worker workspace add ID PATH|list".into());
            }
        }
        "uninstall" => {
            service(&dir, sys, false)?;
            if args.iter().any(|a| a == "--delete-data") {
                // A system install is removed whole: binary, system.json and data.
                let installed = sys.map_or_else(|| dir.clone(), |s| s.root.clone());
                if fs::read(installed.join("managed-install"))? != b"worker-plane-managed-v1" {
                    return Err("refusing to delete an unmanaged directory".into());
                }
                fs::remove_dir_all(&installed)?;
            }
            println!("Uninstalled");
        }
        _ => unreachable!(),
    }
    Ok(None)
}
fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}
fn take_value(args: &mut Vec<String>, flag: &str) -> Result<Option<String>, Error> {
    let Some(i) = args.iter().position(|a| a == flag) else {
        return Ok(None);
    };
    if i + 1 >= args.len() {
        return Err(format!("{flag} requires a value").into());
    }
    let value = args.remove(i + 1);
    args.remove(i);
    Ok(Some(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        std::env::temp_dir().join(format!("worker-cli-{}", uuid::Uuid::new_v4()))
    }
    #[test]
    fn legacy_ca_is_copied_and_commands_are_shell_quoted() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        private_dir(&d).unwrap();
        let source = d.join("external CA.pem");
        fs::write(&source, b"not a certificate").unwrap();
        save(&d.join("service-ca"), source.to_str().unwrap().as_bytes()).unwrap();
        assert!(copy_user_ca(&d, None).is_err());
        assert!(!d.join("ca.pem").exists());
        assert!(
            std::process::Command::new("openssl")
                .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout"])
                .arg(d.join("key.pem"))
                .arg("-out")
                .arg(&source)
                .args(["-days", "1", "-subj", "/CN=installer-test"])
                .output()
                .unwrap()
                .status
                .success()
        );
        save(&d.join("service-ca"), source.to_str().unwrap().as_bytes()).unwrap();
        copy_user_ca(&d, None).unwrap();
        assert_eq!(
            fs::read(d.join("ca.pem")).unwrap(),
            fs::read(&source).unwrap()
        );
        fs::remove_file(&source).unwrap();
        assert_eq!(user_ca(&d), Some(d.join("ca.pem")));
        copy_user_ca(&d, None).unwrap();
        assert_eq!(
            fs::metadata(d.join("ca.pem")).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            shell_quote(Path::new("/a b/o'ne/worker")),
            "'/a b/o'\\''ne/worker'"
        );
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn device_identity_and_default_workspace_survive_repeated_setup() {
        let d = dir();
        private_dir(&d).unwrap();
        setup(&d, "https://localhost:8443").unwrap();
        let first = fs::read(d.join("worker.toml")).unwrap();
        let key = public(&identity(&d).unwrap());
        setup(&d, "https://localhost:8443").unwrap();
        assert_eq!(first, fs::read(d.join("worker.toml")).unwrap());
        assert_eq!(key, public(&identity(&d).unwrap()));
        let config: Config = toml::from_str(std::str::from_utf8(&first).unwrap()).unwrap();
        assert_eq!(config.worker_id, format!("{:x}", Sha256::digest(&key)));
        assert_eq!(config.workspaces.len(), 1);
        assert!(config.workspaces[0].is_default);
        assert!(Path::new(&config.workspaces[0].path).is_dir());
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn private_key_rejects_shared_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        private_dir(&d).unwrap();
        identity(&d).unwrap();
        fs::set_permissions(d.join("identity.pk8"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(identity(&d).is_err());
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn atomic_updates_keep_private_permissions_and_distinct_service_names() {
        use std::os::unix::fs::PermissionsExt;
        let d = dir();
        private_dir(&d).unwrap();
        let p = d.join("token");
        save(&p, b"first").unwrap();
        save(&p, b"second").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"second");
        assert_eq!(
            fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_ne!(service_name(&d), service_name(&d.join("other")));
        fs::remove_dir_all(d).unwrap();
    }
    #[test]
    fn user_unit_is_unchanged_and_system_unit_runs_as_the_account_at_boot() {
        let (exe, dir, ca) = (
            Path::new("/w/bin/worker"),
            Path::new("/w"),
            Path::new("/c/ca.pem"),
        );
        assert_eq!(
            systemd_unit(exe, dir, Some(ca), None),
            "[Unit]\nDescription=WorkerPlane worker\n[Service]\nExecStart=\"/w/bin/worker\" run\nEnvironment=\"WORKER_PLANE_HOME=/w\"\nEnvironment=\"SSL_CERT_FILE=/c/ca.pem\"\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n"
        );
        let unit = systemd_unit(exe, dir, Some(ca), Some("ops"));
        for line in [
            "User=ops\n",
            "ExecStart=\"/w/bin/worker\" run\n",
            "Environment=\"WORKER_PLANE_HOME=/w\"\n",
            "Environment=\"SSL_CERT_FILE=/c/ca.pem\"\n",
            "KillMode=control-group\n",
            "TimeoutStopSec=60\n",
            "WantedBy=multi-user.target\n",
        ] {
            assert!(unit.contains(line), "{line}");
        }
        assert!(!unit.contains("default.target"));
        let agent = launchd_plist("n", exe, dir, None, None);
        assert!(!agent.contains("UserName") && !agent.contains("SSL_CERT_FILE"));
        let daemon = launchd_plist(
            "n",
            exe,
            dir,
            Some(ca),
            Some(("ops", Path::new("/Users/ops"))),
        );
        assert!(daemon.contains("<key>UserName</key><string>ops</string>"));
        assert!(daemon.contains("<key>HOME</key><string>/Users/ops</string>"));
        assert!(daemon.contains("<key>ExitTimeOut</key><integer>60</integer>"));
        assert!(daemon.contains("<key>SSL_CERT_FILE</key><string>/c/ca.pem</string>"));
    }
    #[test]
    fn system_flags_and_accounts_are_validated() {
        let mut a: Vec<String> = ["install", "--system", "--user", "ops"]
            .map(String::from)
            .into();
        assert!(take_flag(&mut a, "--system"));
        assert_eq!(
            take_value(&mut a, "--user").unwrap().as_deref(),
            Some("ops")
        );
        assert_eq!(a, ["install"]);
        let mut b: Vec<String> = ["install", "--user"].map(String::from).into();
        assert!(take_value(&mut b, "--user").is_err());
        for bad in ["", "-x", "a b", "a/b", "a\nUser=root"] {
            assert!(!valid_user(bad), "{bad:?}");
        }
        assert!(valid_user("worker-plane"));
        assert!(lookup("root").is_err());
        assert!(lookup("no-such-account-wp").is_err());
    }
    #[test]
    fn first_argument_is_a_command_help_or_an_existing_config_never_a_typo() {
        assert_eq!(route("join", false), Route::Command);
        assert_eq!(route("--help", false), Route::Help);
        assert_eq!(route("help", false), Route::Help);
        assert_eq!(route("/etc/worker.toml", true), Route::ConfigFile);
        assert_eq!(route("statsu", false), Route::Unknown);
        assert_eq!(route("--version", false), Route::Unknown);
    }
    #[test]
    fn device_name_is_the_hostname_with_safe_fallbacks() {
        assert_eq!(normalize_device_name("my-laptop.local", None), "my-laptop");
        assert_eq!(normalize_device_name("", Some("ci-box")), "ci-box");
        assert_eq!(normalize_device_name("  ", None), "worker");
        assert_eq!(normalize_device_name(&"a".repeat(300), None).len(), 128);
        assert!(!device_name().is_empty());
    }
    #[test]
    fn an_approved_machine_is_not_asked_to_be_approved_again() {
        let pending = join_summary(
            &json!({"worker_id": "w1", "state": "pending"}),
            "ff",
            "https://s",
        );
        assert!(
            pending.contains("Authorization: pending") && pending.contains("核对控制台指纹后批准")
        );
        let approved = join_summary(
            &json!({"worker_id": "w1", "state": "approved"}),
            "ff",
            "https://s",
        );
        assert!(
            approved.contains("Authorization: approved")
                && !approved.contains("核对控制台指纹后批准")
        );
        assert!(approved.contains("无需再次批准"));
    }
}
