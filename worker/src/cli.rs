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
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
async fn client() -> Result<reqwest::Client, Error> {
    let mut b = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(15));
    if let Some(p) = std::env::var_os("SSL_CERT_FILE") {
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
fn service_running(dir: &Path) -> bool {
    let name = service_name(dir);
    if cfg!(target_os = "macos") {
        Command::new("launchctl")
            .args([
                "print",
                &format!("gui/{}/{name}", unsafe { libc::getuid() }),
            ])
            .output()
            .is_ok_and(|o| o.status.success())
    } else {
        Command::new("systemctl")
            .args(["--user", "is-active", &format!("{name}.service")])
            .output()
            .is_ok_and(|o| o.status.success())
    }
}
fn wait_stopped(dir: &Path) -> Result<(), Error> {
    for _ in 0..300 {
        if !service_running(dir) && !worker_running(dir) {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    Err("service is still running; operation stopped before data removal".into())
}
fn service(dir: &Path, install: bool) -> Result<(), Error> {
    let name = service_name(dir);
    let exe = dir.join("bin/worker");
    let config = dir.join("worker.toml");
    let ca = fs::read_to_string(dir.join("service-ca")).ok();
    let home = PathBuf::from(std::env::var_os("HOME").ok_or("HOME required")?);
    if cfg!(target_os = "macos") {
        let directory = std::env::var_os("WORKER_PLANE_LAUNCH_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("Library/LaunchAgents"));
        if !directory.is_absolute() {
            return Err("LaunchAgent directory must be absolute".into());
        }
        let path = directory.join(format!("{name}.plist"));
        if install {
            fs::create_dir_all(path.parent().unwrap())?;
            let xml = |p: &Path| {
                p.to_string_lossy()
                    .replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            };
            save(&path,format!("<?xml version=\"1.0\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>{name}</string><key>ProgramArguments</key><array><string>{}</string><string>run</string></array><key>EnvironmentVariables</key><dict><key>WORKER_PLANE_HOME</key><string>{}</string>{}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(&exe),xml(dir),ca.as_ref().map(|p|format!("<key>SSL_CERT_FILE</key><string>{}</string>",xml(Path::new(p)))).unwrap_or_default(),xml(&dir.join("service.log"))).as_bytes())?;
            let domain = format!("gui/{}", unsafe { libc::getuid() });
            let _ = Command::new("launchctl")
                .args(["bootout", &domain])
                .arg(&path)
                .output();
            wait_stopped(dir)?;
            if !Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(path)
                .status()?
                .success()
            {
                return Err("launchctl bootstrap failed".into());
            }
        } else {
            let target = format!("gui/{}/{name}", unsafe { libc::getuid() });
            let _ = Command::new("launchctl")
                .args(["bootout", &target])
                .output();
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    } else {
        let path = home.join(format!(".config/systemd/user/{name}.service"));
        if install {
            fs::create_dir_all(path.parent().unwrap())?;
            let quote = |p: &Path| {
                p.to_string_lossy()
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
            };
            save(&path,format!("[Unit]\nDescription=WorkerPlane worker\n[Service]\nExecStart=\"{}\" run\nEnvironment=\"WORKER_PLANE_HOME={}\"\n{}Restart=on-failure\nRestartSec=5\n[Install]\nWantedBy=default.target\n",quote(&exe),quote(dir),ca.as_ref().map(|p|format!("Environment=\"SSL_CERT_FILE={}\"\n",quote(Path::new(p)))).unwrap_or_default()).as_bytes())?;
            for args in [
                &["--user", "daemon-reload"][..],
                &["--user", "enable", &format!("{name}.service")][..],
                &["--user", "restart", &format!("{name}.service")][..],
            ] {
                if !Command::new("systemctl").args(args).status()?.success() {
                    return Err("systemctl failed; a user session is required".into());
                }
            }
        } else {
            let _ = Command::new("systemctl")
                .args(["--user", "disable", "--now", &format!("{name}.service")])
                .output();
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    let _ = (config, ca);
    if !install {
        wait_stopped(dir)?;
    }
    Ok(())
}
pub async fn dispatch() -> Result<Option<PathBuf>, Error> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        return Err("usage: worker install|join URL|status [--json]|workspace add ID PATH|workspace list|run|uninstall [--delete-data]|config.toml".into());
    };
    if !["install", "join", "status", "workspace", "run", "uninstall"].contains(&command) {
        return Ok(Some(PathBuf::from(command)));
    }
    let dir = root()?;
    private_dir(&dir)?;
    match command {
        "install" => {
            let running = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(dir.join("worker.lock"))
                .ok()
                .map(|f| fs2::FileExt::try_lock_exclusive(&f).is_err())
                .unwrap_or(false);
            if running {
                proof(&dir, "workspace").await?;
            }
            if let Ok(ca) = std::env::var("SSL_CERT_FILE") {
                let ca = fs::canonicalize(ca)?;
                save(&dir.join("service-ca"), ca.to_string_lossy().as_bytes())?;
            }
            private_dir(&dir.join("bin"))?;
            use std::os::unix::fs::PermissionsExt;
            let target = dir.join("bin/worker");
            let current = std::env::current_exe()?;
            if current != target {
                save(&target, &fs::read(current)?)?;
                fs::set_permissions(&target, fs::Permissions::from_mode(0o700))?;
            }
            save(&dir.join("managed-install"), b"worker-plane-managed-v1")?;
            service(&dir, true)?;
            println!("Service: {}", service_name(&dir));
            println!(
                "Installed. Run: {} join https://your-server",
                target.display()
            );
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
                save(&dir.join("enrollment.json"),serde_json::to_string(&json!({"url":base,"name":std::env::var("HOSTNAME").unwrap_or_else(|_|"worker".into())}))?.as_bytes())?;
            }
            setup(&dir, base)?;
            let state = proof(&dir, "apply").await?;
            println!(
                "Node: {}\nAuthorization: {}",
                state["worker_id"], state["state"]
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
            state["service_running"] = json!(service_running(&dir));
            state["service_name"] = json!(service_name(&dir));
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
            service(&dir, false)?;
            if args.iter().any(|a| a == "--delete-data") {
                if fs::read(dir.join("managed-install"))? != b"worker-plane-managed-v1" {
                    return Err("refusing to delete an unmanaged directory".into());
                }
                fs::remove_dir_all(&dir)?;
            }
            println!("Uninstalled");
        }
        _ => unreachable!(),
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dir() -> PathBuf {
        std::env::temp_dir().join(format!("worker-cli-{}", uuid::Uuid::new_v4()))
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
}
