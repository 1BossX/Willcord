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
    if let Some(p) = std::env::var_os("WILLCORD_SYSTEM_ROOT") {
        let path = PathBuf::from(p);
        if !path.is_absolute() || path == Path::new("/") {
            return Err("WILLCORD_SYSTEM_ROOT must be an absolute directory".into());
        }
        return Ok(path);
    }
    Ok(PathBuf::from(if cfg!(target_os = "macos") {
        "/Library/Application Support/Willcord"
    } else {
        "/var/lib/willcord-system"
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
    if let Some(p) = std::env::var_os("WILLCORD_HOME") {
        let path = PathBuf::from(p);
        if !path.is_absolute()
            || path == Path::new("/")
            || std::env::var_os("HOME").is_some_and(|h| path == PathBuf::from(h))
        {
            return Err("WILLCORD_HOME must be an absolute private application directory".into());
        }
        return Ok(path);
    }
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME required")?);
    Ok(if cfg!(target_os = "macos") {
        home.join("Library/Application Support/Willcord")
    } else {
        home.join(".local/share/willcord")
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
pub(crate) fn shell_quote(value: &Path) -> String {
    format!("'{}'", value.to_string_lossy().replace('\'', "'\\''"))
}
fn client_trusting(ca: Option<&Path>) -> Result<reqwest::Client, Error> {
    let mut b = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15));
    if let Some(p) = ca {
        for cert in reqwest::Certificate::from_pem_bundle(&fs::read(p)?)? {
            b = b.add_root_certificate(cert);
        }
    }
    Ok(b.build()?)
}
async fn client() -> Result<reqwest::Client, Error> {
    let ca = std::env::var_os("SSL_CERT_FILE")
        .map(PathBuf::from)
        .or_else(|| SYSTEM_CA.get().cloned());
    client_trusting(ca.as_deref())
}
/// The root certificate a main node publishes for first contact. This is the one
/// request made without verifying the server, which is only safe because the
/// certificate it returns must match a fingerprint the person got out of band,
/// and nothing else from that connection is used. Returns a private temporary file.
async fn fetch_pinned_ca(base: &str, fingerprint: &str) -> Result<PathBuf, Error> {
    const LIMIT: usize = 64 * 1024;
    if fingerprint.len() != 64 || !fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("CA 指纹必须是证书 DER 的 64 位 SHA-256。".into());
    }
    let client = reqwest::Client::builder()
        .https_only(true)
        .danger_accept_invalid_certs(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(5))
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    let mut response = client
        .get(format!("{base}/.well-known/willcord/ca.pem"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("根证书获取失败：{e}"))?;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        body.extend_from_slice(&chunk);
        if body.len() > LIMIT {
            return Err("根证书响应过大。".into());
        }
    }
    let pem = pinned_ca_pem(&body, fingerprint)?;
    let path = std::env::temp_dir().join(format!("willcord-ca-{}.pem", uuid::Uuid::new_v4()));
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?
        .write_all(pem.as_bytes())?;
    Ok(path)
}
/// A single certificate whose DER hashes to `fingerprint`, as clean PEM; anything
/// else the response carried is dropped.
fn pinned_ca_pem(body: &[u8], fingerprint: &str) -> Result<String, Error> {
    let text = std::str::from_utf8(body).map_err(|_| "根证书不是文本 PEM。")?;
    if text.matches("-----BEGIN CERTIFICATE-----").count() != 1
        || text.matches("-----END CERTIFICATE-----").count() != 1
    {
        return Err("必须提供单张根证书。".into());
    }
    // Must be something rustls would accept as a trust anchor, not merely base64.
    reqwest::Certificate::from_pem(body).map_err(|_| "根证书格式无效。")?;
    let inner = text
        .split_once("-----BEGIN CERTIFICATE-----")
        .and_then(|(_, rest)| rest.split_once("-----END CERTIFICATE-----"))
        .map(|(inner, _)| inner.split_whitespace().collect::<String>())
        .ok_or("根证书格式无效。")?;
    let der = B64.decode(inner).map_err(|_| "根证书格式无效。")?;
    if format!("{:x}", Sha256::digest(&der)) != fingerprint.to_ascii_lowercase() {
        return Err("CA 指纹不匹配，未安装或申请加入。".into());
    }
    let b64 = B64.encode(&der);
    let mut pem = String::from("-----BEGIN CERTIFICATE-----\n");
    for line in b64.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(line)?);
        pem.push('\n');
    }
    pem.push_str("-----END CERTIFICATE-----\n");
    Ok(pem)
}
/// Before anything is installed: does the main node answer HTTPS under this trust?
async fn check_main_node(base: &str, ca: Option<&Path>) -> Result<(), Error> {
    let client = client_trusting(ca)?;
    client
        .get(format!("{base}/health"))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("无法通过 CA 验证主节点 HTTPS，请检查证书、地址与网络：{e}"))?;
    Ok(())
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
        "willcord-enrollment-v1",
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
        format!("org.willcord.worker.{}", &suffix[..12])
    } else {
        format!("willcord-worker-{}", &suffix[..12])
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
        "<?xml version=\"1.0\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{name}</string>{daemon}<key>ProgramArguments</key><array><string>{}</string><string>worker</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>WILLCORD_HOME</key><string>{}</string>{}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>{}</string></dict></plist>",
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
            "[Unit]\nDescription=Willcord worker\n[Service]\nExecStart=\"{}\" worker run\nEnvironment=\"WILLCORD_HOME={}\"\n{ca}Restart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n",
            unit_quote(exe),
            unit_quote(dir)
        ),
        // Mirrors deploy/systemd/willcord-worker.service.
        Some(u) => format!(
            "[Unit]\nDescription=Willcord worker\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser={u}\nExecStart=\"{}\" worker run\nEnvironment=\"WILLCORD_HOME={}\"\n{ca}KillSignal=SIGTERM\nTimeoutStopSec=60\nKillMode=control-group\nRestart=on-failure\nRestartSec=10\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n",
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
        Some(s) => s.root.join("bin/willcord"),
        None => dir.join("bin/willcord"),
    };
    let ca = match sys {
        Some(s) => s.ca.clone(),
        None => user_ca(dir),
    };
    let user = sys.map(|s| s.user.as_str());
    if cfg!(target_os = "macos") {
        let directory = match sys {
            Some(_) => PathBuf::from("/Library/LaunchDaemons"),
            None => std::env::var_os("WILLCORD_LAUNCH_AGENT_DIR")
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
/// Copy this binary into the data directory, put the command on PATH, and
/// (re)start the service. Returns the installed copy and the command to show in hints.
async fn install_service(
    dir: &Path,
    sys: Option<&System>,
    ca: Option<PathBuf>,
) -> Result<(PathBuf, String), Error> {
    if worker_running(dir) {
        proof(dir, "workspace").await?;
    }
    use std::os::unix::fs::PermissionsExt;
    let (target, mode) = match sys {
        Some(s) => (s.root.join("bin/willcord"), 0o755),
        None => {
            copy_user_ca(dir, ca)?;
            private_dir(&dir.join("bin"))?;
            (dir.join("bin/willcord"), 0o700)
        }
    };
    let current = std::env::current_exe()?;
    if current != target {
        save(&target, &fs::read(current)?)?;
        fs::set_permissions(&target, fs::Permissions::from_mode(mode))?;
    }
    let marker = sys.map_or_else(|| dir.to_owned(), |s| s.root.clone());
    if sys.is_some() {
        save_public(&marker.join("managed-install"), b"willcord-managed-v1")?;
    } else {
        save(&marker.join("managed-install"), b"willcord-managed-v1")?;
    }
    service(dir, sys, true)?;
    let scope = if sys.is_some() {
        Scope::System
    } else {
        Scope::User
    };
    let command = crate::path_install::ensure(scope, &target);
    Ok((target, command))
}
use crate::path_install::Scope;
fn install_system(root: &Path, user: Option<&str>, ca: Option<PathBuf>) -> Result<System, Error> {
    if unsafe { libc::geteuid() } != 0 {
        return Err("a system service must be installed as root (sudo)".into());
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
    let ca = match ca {
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
/// What `install` tells the person to run next: the `worker join` command under
/// the `worker` namespace, spelled the way it can be run (`command`).
fn install_next_step(system_user: Option<&str>, command: &str, attempted: bool) -> String {
    let note = if attempted {
        " (a join was already attempted; this shows its current state)"
    } else {
        ""
    };
    match system_user {
        Some(user) => format!(
            "Installed as a system service running as {user}. Next: sudo {command} worker join --system <server-https-origin>{note}"
        ),
        None => format!("Installed. Next: {command} worker join <server-https-origin>{note}"),
    }
}
/// The command that shows this machine's state, as it can be typed.
fn status_command(command: &str, system: bool) -> String {
    if system {
        format!("sudo {command} worker status --system --json")
    } else {
        format!("{command} worker status --json")
    }
}
/// What `join` tells the person: an already approved machine has nothing left to approve.
fn join_summary(state: &Value, fingerprint: &str, base: &str, status: &str) -> String {
    let authorization = state["state"].as_str().unwrap_or("unknown");
    let next = match authorization {
        "approved" => "本机已获授权，无需再次批准；等待控制台显示“可执行”后即可使用。",
        "pending" => "核对控制台指纹后批准；等待机器显示可执行，再验证只读任务。",
        "rejected" | "revoked" => "此机器的授权已被拒绝或撤销；如需恢复，请在控制台重新批准。",
        _ => "请在控制台查看本机的授权状态。",
    };
    format!(
        "Node: {}\nFingerprint (SHA-256 of public key): {fingerprint}\nAuthorization: {authorization}\nConsole: {base}\nNext: {next}\nStatus: {status}",
        state["worker_id"].as_str().unwrap_or("unknown"),
    )
}
/// A bare HTTPS origin, without a trailing slash.
fn https_origin(raw: &str) -> Result<String, Error> {
    let url = reqwest::Url::parse(raw)?;
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
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
/// The CA an earlier install of this scope saved.
fn saved_ca(system: bool) -> Option<PathBuf> {
    if system {
        read_system(&system_root().ok()?).ok()?.ca
    } else {
        user_ca(&root().ok()?)
    }
}
/// The service copy differs from this binary, or is missing.
fn install_needed(system: bool) -> Result<bool, Error> {
    let target = if system {
        system_root()?.join("bin/willcord")
    } else {
        root()?.join("bin/willcord")
    };
    let current = std::env::current_exe()?;
    if !target.is_file() {
        return Ok(true);
    }
    if fs::canonicalize(&target)? == fs::canonicalize(&current)? {
        return Ok(false);
    }
    Ok(fs::read(&target)? != fs::read(&current)?)
}
/// A user service needs a session to live in; saying so beforehand beats failing
/// halfway through an install.
fn session_available(system: bool) -> Result<(), Error> {
    if system {
        return Ok(());
    }
    let (ok, why) = if cfg!(target_os = "macos") {
        (
            Command::new("launchctl")
                .args(["print", &format!("gui/{}", unsafe { libc::getuid() })])
                .output()
                .is_ok_and(|o| o.status.success()),
            "macOS 用户级服务需要登录图形会话。",
        )
    } else {
        (
            Command::new("systemctl")
                .args(["--user", "show-environment"])
                .output()
                .is_ok_and(|o| o.status.success()),
            "需要 systemd 用户会话；常驻服务器请用 --system --user ACCOUNT。",
        )
    };
    if ok { Ok(()) } else { Err(why.into()) }
}
/// `willcord worker join URL`, on a machine where the service is not installed
/// yet (or is an older build): install it, then join through the installed copy.
/// `--ca FILE` or `--ca-fingerprint SHA256` says whom to trust for a private CA.
/// Returns false when there is nothing to install and the plain join should run.
async fn join_installing(args: &[String]) -> Result<bool, Error> {
    let mut probe = args.to_vec();
    let ca = take_value(&mut probe, "--ca")?;
    let fingerprint = take_value(&mut probe, "--ca-fingerprint")?;
    let system = take_flag(&mut probe, "--system");
    let account = take_value(&mut probe, "--user")?;
    if ca.is_some() && fingerprint.is_some() {
        return Err("--ca 与 --ca-fingerprint 不能同时使用。".into());
    }
    if ca.is_none() && fingerprint.is_none() && !install_needed(system)? {
        return Ok(false);
    }
    if probe.len() != 2 {
        return Err("usage: willcord worker join URL [--ca FILE | --ca-fingerprint SHA256] [--system --user ACCOUNT]".into());
    }
    let base = https_origin(&probe[1])?;
    let unix_euid = unsafe { libc::geteuid() };
    if system {
        if account.is_none() {
            return Err("--system 需要 --user 指定已有普通账户。".into());
        }
        if unix_euid != 0 {
            return Err("系统级安装需要 root：请用 sudo 运行。".into());
        }
    } else {
        if account.is_some() {
            return Err("--user 只能与 --system 一起使用。".into());
        }
        if unix_euid == 0 {
            return Err("用户级安装请不要使用 sudo；服务器请指定 --system --user。".into());
        }
    }
    if let Some(file) = &ca {
        let path = Path::new(file);
        if !path.is_absolute() || !path.is_file() || fs::File::open(path).is_err() {
            return Err("CA 必须是可读的绝对文件路径。".into());
        }
    }
    session_available(system)?;
    let temporary = match &fingerprint {
        Some(fp) => {
            let path = fetch_pinned_ca(&base, fp).await?;
            println!("CA 指纹已核对：{}", fp.to_ascii_lowercase());
            Some(path)
        }
        None => None,
    };
    let ca_file = temporary
        .clone()
        .or_else(|| ca.map(PathBuf::from))
        .or_else(|| std::env::var_os("SSL_CERT_FILE").map(PathBuf::from))
        // Re-running the installer to upgrade needs no CA again: the first install kept it.
        .or_else(|| saved_ca(system));
    let installed = async {
        check_main_node(&base, ca_file.as_deref()).await?;
        let (sys, dir) = if system {
            let sys = install_system(&system_root()?, account.as_deref(), ca_file.clone())?;
            let dir = sys.data();
            (Some(sys), dir)
        } else {
            let dir = root()?;
            private_dir(&dir)?;
            (None, dir)
        };
        let (target, _) = install_service(&dir, sys.as_ref(), ca_file.clone()).await?;
        Ok::<PathBuf, Error>(target)
    }
    .await;
    if let Some(path) = temporary {
        let _ = fs::remove_file(path);
    }
    let target = installed?;
    // The installed copy joins, so the service and the join run the same build.
    let mut join = Command::new(target);
    join.args(["worker", "join"]);
    if system {
        join.arg("--system");
    }
    let status = join.arg(&base).status()?;
    std::process::exit(status.code().unwrap_or(1));
}
const USAGE: &str = "usage:
  willcord main init [--dir DIR] [--server HTTPS_ORIGIN] [--image-version vX.Y.Z]
  willcord main up | down | status | logs [SERVICE...] | upgrade --image-version vX.Y.Z   (add --dir DIR outside the deployment directory)
  willcord worker install [--system --user ACCOUNT] | join URL [--ca FILE | --ca-fingerprint SHA256] [--system --user ACCOUNT] [--no-service] | status [--json] | workspace add ID PATH | workspace list | run [--config FILE] | uninstall [--delete-data]   (add --system to manage the system service)
  willcord self-install | self-uninstall [--system]   (put this program on PATH, or take it off again)
  willcord version";
/// A mistyped command is not a failure with a backtrace-style message: say so plainly and exit.
fn usage_error(command: Option<&str>) -> ! {
    if let Some(command) = command {
        eprintln!("willcord: unknown command '{command}'");
        // The worker commands used to be top-level.
        if COMMANDS.contains(&command) {
            eprintln!("你是不是想运行：willcord worker {command} …");
        }
    }
    eprintln!("{USAGE}");
    std::process::exit(2)
}
const COMMANDS: [&str; 6] = ["install", "join", "status", "workspace", "run", "uninstall"];
/// What the first argument means: a command, a request for help, or a typo.
#[derive(Debug, PartialEq)]
enum Route {
    Command,
    Help,
    Unknown,
}
fn route(first: &str) -> Route {
    if COMMANDS.contains(&first) {
        Route::Command
    } else if ["-h", "--help", "help"].contains(&first) {
        Route::Help
    } else {
        Route::Unknown
    }
}
/// `willcord main …` sets up and operates the main node; `willcord worker …`
/// is the execution machine. The worker commands run on from here.
pub async fn dispatch() -> Result<Option<PathBuf>, Error> {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None => usage_error(None),
        Some("main") => {
            if let Err(e) = crate::main_node::dispatch(args.split_off(1)).await {
                eprintln!("willcord: {e}");
                std::process::exit(1);
            }
            return Ok(None);
        }
        Some("worker") => {
            args.remove(0);
        }
        Some(command @ ("self-install" | "self-uninstall")) => {
            let command = command.to_owned();
            args.remove(0);
            let scope = if take_flag(&mut args, "--system") {
                crate::path_install::Scope::System
            } else {
                crate::path_install::Scope::User
            };
            if let Some(extra) = args.first() {
                return Err(format!("unexpected argument '{extra}'\n{USAGE}").into());
            }
            let text = if command == "self-install" {
                match crate::path_install::install_running(scope)? {
                    // Exit status 0 would claim a command that is not there.
                    (crate::path_install::Installed::Foreign, text) => {
                        eprintln!("{text}");
                        std::process::exit(1);
                    }
                    (_, text) => text,
                }
            } else {
                crate::path_install::uninstall_running(scope)?.1
            };
            println!("{text}");
            return Ok(None);
        }
        Some("version" | "-V" | "--version") => {
            println!("willcord {}", crate::main_node::version().unwrap_or("dev"));
            return Ok(None);
        }
        Some("help" | "-h" | "--help") => {
            println!("{USAGE}");
            return Ok(None);
        }
        Some(other) => usage_error(Some(other)),
    }
    worker(args).await
}
async fn worker(mut args: Vec<String>) -> Result<Option<PathBuf>, Error> {
    let Some(command) = args.first().cloned() else {
        usage_error(None);
    };
    let command = command.as_str();
    match route(command) {
        Route::Command => {}
        Route::Help => {
            println!("{USAGE}");
            return Ok(None);
        }
        Route::Unknown => usage_error(Some(command)),
    }
    // `join --no-service` only files the request, for a process managed some other way.
    let no_service = command == "join" && take_flag(&mut args, "--no-service");
    if no_service && args.iter().any(|a| a == "--ca" || a == "--ca-fingerprint") {
        return Err(
            "--no-service 不安装服务，也就不保存 CA：不能与 --ca、--ca-fingerprint 同用。".into(),
        );
    }
    if command == "join" && !no_service && join_installing(&args).await? {
        return Ok(None);
    }
    // A hand-installed service names its configuration file instead of
    // enrolling: `willcord worker run --config /etc/willcord/worker.toml`.
    if command == "run" {
        if let Some(file) = take_value(&mut args, "--config")? {
            return Ok(Some(PathBuf::from(file)));
        }
    }
    let system = take_flag(&mut args, "--system");
    let account = take_value(&mut args, "--user")?;
    if account.is_some() && !(system && ["install", "join"].contains(&command)) {
        return Err("--user only applies to install --system and join --system".into());
    }
    if system && command == "run" {
        return Err("run takes WILLCORD_HOME from the service definition".into());
    }
    let sys = if !system {
        None
    } else if command == "install" {
        let ca = std::env::var_os("SSL_CERT_FILE").map(PathBuf::from);
        Some(install_system(&system_root()?, account.as_deref(), ca)?)
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
            let ca = std::env::var_os("SSL_CERT_FILE").map(PathBuf::from);
            let (target, command) = install_service(&dir, sys, ca).await?;
            println!("Service: {}", service_name(&dir));
            // enrollment.json is written before the request is sent, so it proves an
            // attempt, not an accepted one: always point at `join` for the real state.
            let attempted = dir.join("enrollment.json").exists();
            let _ = target;
            println!(
                "{}",
                install_next_step(sys.map(|s| s.user.as_str()), &command, attempted)
            );
        }
        "join" => {
            let base = https_origin(args.get(1).ok_or("join requires HTTPS URL")?)?;
            let base = base.as_str();
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
            let scope = if sys.is_some() {
                Scope::System
            } else {
                Scope::User
            };
            let command = crate::path_install::command_for(scope, &std::env::current_exe()?);
            println!(
                "{}",
                join_summary(
                    &state,
                    &format!("{:x}", Sha256::digest(public(&identity(&dir)?))),
                    base,
                    &status_command(&command, sys.is_some()),
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
                return Err("usage: willcord workspace add ID PATH|list".into());
            }
        }
        "uninstall" => {
            service(&dir, sys, false)?;
            if args.iter().any(|a| a == "--delete-data") {
                // A system install is removed whole: binary, system.json and data.
                let installed = sys.map_or_else(|| dir.clone(), |s| s.root.clone());
                if fs::read(installed.join("managed-install"))? != b"willcord-managed-v1" {
                    return Err("refusing to delete an unmanaged directory".into());
                }
                fs::remove_dir_all(&installed)?;
            }
            println!("Uninstalled");
            let scope = if sys.is_some() {
                Scope::System
            } else {
                Scope::User
            };
            if crate::path_install::bin_dir(scope)
                .is_ok_and(|d| crate::path_install::is_ours(&d.join("willcord")))
            {
                println!(
                    "willcord 命令仍留在 PATH（主节点命令也用它）。不再需要时运行：{}willcord self-uninstall{}",
                    if sys.is_some() { "sudo " } else { "" },
                    if sys.is_some() { " --system" } else { "" }
                );
            }
        }
        _ => unreachable!(),
    }
    Ok(None)
}
pub(crate) fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let before = args.len();
    args.retain(|a| a != flag);
    args.len() != before
}
pub(crate) fn take_value(args: &mut Vec<String>, flag: &str) -> Result<Option<String>, Error> {
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
            Path::new("/w/bin/willcord"),
            Path::new("/w"),
            Path::new("/c/ca.pem"),
        );
        assert_eq!(
            systemd_unit(exe, dir, Some(ca), None),
            "[Unit]\nDescription=Willcord worker\n[Service]\nExecStart=\"/w/bin/willcord\" worker run\nEnvironment=\"WILLCORD_HOME=/w\"\nEnvironment=\"SSL_CERT_FILE=/c/ca.pem\"\nRestart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n"
        );
        let unit = systemd_unit(exe, dir, Some(ca), Some("ops"));
        for line in [
            "User=ops\n",
            "ExecStart=\"/w/bin/willcord\" worker run\n",
            "Environment=\"WILLCORD_HOME=/w\"\n",
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
    fn the_next_step_after_install_is_a_worker_command() {
        let user = install_next_step(None, "willcord", false);
        assert_eq!(
            user,
            "Installed. Next: willcord worker join <server-https-origin>"
        );
        let system = install_next_step(Some("ops"), "willcord", true);
        assert!(system.contains(
            "running as ops. Next: sudo willcord worker join --system <server-https-origin>"
        ));
        assert!(system.ends_with("already attempted; this shows its current state)"));
        // Every command it names must route: nothing is left at the top level.
        assert_eq!(route("worker"), Route::Unknown);
    }
    fn test_certificate() -> (String, String) {
        let d = dir();
        private_dir(&d).unwrap();
        let (cert, key) = (d.join("ca.pem"), d.join("key.pem"));
        assert!(
            std::process::Command::new("openssl")
                .args(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout"])
                .arg(&key)
                .arg("-out")
                .arg(&cert)
                .args(["-days", "1", "-subj", "/CN=pin-test"])
                .output()
                .unwrap()
                .status
                .success()
        );
        let der = std::process::Command::new("openssl")
            .args(["x509", "-outform", "DER", "-in"])
            .arg(&cert)
            .output()
            .unwrap()
            .stdout;
        let pem = fs::read_to_string(&cert).unwrap();
        fs::remove_dir_all(d).unwrap();
        (pem, format!("{:x}", Sha256::digest(der)))
    }
    #[test]
    fn a_published_ca_is_trusted_only_when_it_matches_the_pinned_fingerprint() {
        let (pem, pin) = test_certificate();
        let clean = pinned_ca_pem(pem.as_bytes(), &pin).unwrap();
        assert!(clean.starts_with("-----BEGIN CERTIFICATE-----\n"));
        // Upper-case fingerprints are the same fingerprint.
        pinned_ca_pem(pem.as_bytes(), &pin.to_uppercase()).unwrap();
        // Text around the certificate is dropped, not saved.
        let padded = format!("junk\n{pem}\ntrailing");
        let cleaned = pinned_ca_pem(padded.as_bytes(), &pin).unwrap();
        assert!(!cleaned.contains("junk") && !cleaned.contains("trailing"));
        // The cleaned certificate is the same certificate.
        assert_eq!(pinned_ca_pem(cleaned.as_bytes(), &pin).unwrap(), cleaned);
        let wrong = "0".repeat(64);
        assert!(
            pinned_ca_pem(pem.as_bytes(), &wrong)
                .unwrap_err()
                .to_string()
                .contains("指纹不匹配")
        );
        // Two certificates, none, or garbage are all refused.
        assert!(pinned_ca_pem(format!("{pem}{pem}").as_bytes(), &pin).is_err());
        assert!(pinned_ca_pem(b"", &pin).is_err());
        assert!(
            pinned_ca_pem(
                b"-----BEGIN CERTIFICATE-----\n!!\n-----END CERTIFICATE-----\n",
                &pin
            )
            .is_err()
        );
        assert!(pinned_ca_pem(&[0xff, 0xfe], &pin).is_err());
    }
    #[test]
    fn join_takes_a_bare_https_origin() {
        assert_eq!(
            https_origin("https://plane.internal:8443/").unwrap(),
            "https://plane.internal:8443"
        );
        for bad in [
            "http://plane.internal",
            "https://plane.internal/path",
            "https://plane.internal/?q=1",
            "https://u:p@plane.internal",
            "plane.internal",
        ] {
            assert!(https_origin(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn the_status_command_follows_the_scope() {
        assert_eq!(
            status_command("willcord", false),
            "willcord worker status --json"
        );
        assert_eq!(
            status_command("willcord", true),
            "sudo willcord worker status --system --json"
        );
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
        assert!(valid_user("willcord"));
        assert!(lookup("root").is_err());
        assert!(lookup("no-such-account-wp").is_err());
    }
    #[test]
    fn first_argument_is_a_command_help_or_an_existing_config_never_a_typo() {
        assert_eq!(route("join"), Route::Command);
        assert_eq!(route("--help"), Route::Help);
        assert_eq!(route("help"), Route::Help);
        assert_eq!(route("statsu"), Route::Unknown);
        assert_eq!(route("--version"), Route::Unknown);
        // The legacy `worker /path/to/worker.toml` form is gone: a path is a typo now.
        assert_eq!(route("/etc/willcord/worker.toml"), Route::Unknown);
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
            "willcord worker status --json",
        );
        assert!(
            pending.contains("Authorization: pending") && pending.contains("核对控制台指纹后批准")
        );
        let approved = join_summary(
            &json!({"worker_id": "w1", "state": "approved"}),
            "ff",
            "https://s",
            "willcord worker status --json",
        );
        assert!(
            approved.contains("Authorization: approved")
                && !approved.contains("核对控制台指纹后批准")
        );
        assert!(approved.contains("无需再次批准"));
    }
}
