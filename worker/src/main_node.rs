//! `willcord main …`: set up and operate the main node, which runs under
//! Docker Compose (docs/docker.md). `init` is the former `install.sh main`
//! wizard; the other commands wrap `docker compose` in the deployment
//! directory so nobody has to remember it.
use crate::{
    Error,
    cli::{shell_quote, take_value},
    netaddr,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

const COMPOSE: &str = include_str!("../../deploy/docker/compose.yaml");
const DEFAULT_PORT: u16 = 8443;
const DEFAULT_SERVER: &str = "https://plane.internal:8443";
const MAIN_USAGE: &str = "usage: willcord main init [--dir DIR] [--server HTTPS_ORIGIN] [--image-version vX.Y.Z] | up | down | status | logs [SERVICE...] | upgrade --image-version vX.Y.Z  (add --dir DIR outside the deployment directory)";
const RECOVERY: &str = "启动未完成，配置和数据已保留。请在部署目录执行 docker compose logs main caddy 查看原因；修复后执行 docker compose up -d。";

/// The release this binary was built for, set by the release workflow.
pub fn version() -> Option<&'static str> {
    option_env!("WILLCORD_VERSION").filter(|v| !v.is_empty())
}

pub async fn dispatch(mut args: Vec<String>) -> Result<(), Error> {
    if args.is_empty() {
        return Err(MAIN_USAGE.into());
    }
    let command = args.remove(0);
    match command.as_str() {
        "init" => init(args).await,
        "up" => run_in_deployment(args, &["up", "-d"]),
        "down" => run_in_deployment(args, &["down"]),
        "logs" => logs(args),
        "status" => status(args).await,
        "upgrade" => upgrade(args).await,
        "help" | "-h" | "--help" => {
            println!("{MAIN_USAGE}");
            Ok(())
        }
        other => Err(format!("unknown main command '{other}'\n{MAIN_USAGE}").into()),
    }
}

// ---------------------------------------------------------------- parsing

#[derive(Debug, PartialEq)]
struct Origin {
    /// `host:port`, what Caddy and `WILLCORD_SITE` use.
    site: String,
    /// `https://host[:port]`, what browsers and workers use.
    server: String,
    port: u16,
}
const ORIGIN_HELP: &str =
    "地址必须是 HTTPS origin（主机及可选端口，不含路径、用户信息或查询参数）。";
fn parse_origin(input: &str) -> Result<Origin, Error> {
    let rest = input.strip_prefix("https://").ok_or(ORIGIN_HELP)?;
    let rest = rest.strip_suffix('/').unwrap_or(rest);
    let (host, port) = if let Some(inner) = rest.strip_prefix('[') {
        let (addr, tail) = inner.split_once(']').ok_or(ORIGIN_HELP)?;
        if addr.is_empty() || !addr.bytes().all(|b| b.is_ascii_hexdigit() || b == b':') {
            return Err(ORIGIN_HELP.into());
        }
        // Anything after the bracket other than a port (a pasted path, say) is
        // refused, as it is for host names.
        if !tail.is_empty() && !tail.starts_with(':') {
            return Err(ORIGIN_HELP.into());
        }
        (format!("[{addr}]"), tail.strip_prefix(':'))
    } else {
        let (host, port) = match rest.split_once(':') {
            Some((h, p)) => (h, Some(p)),
            None => (rest, None),
        };
        let first = host.bytes().next().ok_or(ORIGIN_HELP)?;
        if !first.is_ascii_alphanumeric()
            || !host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        {
            return Err(ORIGIN_HELP.into());
        }
        (host.to_ascii_lowercase(), port)
    };
    let port = match port {
        None => 443,
        Some(p) => {
            if p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ORIGIN_HELP.into());
            }
            match p.parse::<u16>() {
                Ok(n) if n >= 1 && p.len() <= 5 => n,
                _ => return Err("端口必须在 1–65535 之间。".into()),
            }
        }
    };
    let server = if port == 443 {
        format!("https://{host}")
    } else {
        format!("https://{host}:{port}")
    };
    Ok(Origin {
        site: format!("{host}:{port}"),
        server,
        port,
    })
}

/// One `KEY="value"` line that Compose reads back verbatim, including secrets:
/// backslashes and double quotes are escaped and `$` is doubled so nothing is
/// interpolated.
fn env_line(key: &str, value: &str) -> Result<String, Error> {
    if value.contains(['\n', '\r']) {
        return Err("配置值不能包含换行。".into());
    }
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "$$");
    Ok(format!("{key}=\"{escaped}\"\n"))
}

/// Each deployment directory gets its own project name, so two deployments on
/// one host do not share volumes.
fn project_name(dir: &Path) -> String {
    let digest = format!("{:x}", Sha256::digest(dir.as_os_str().as_encoded_bytes()));
    format!("willcord-{}", &digest[..12])
}

fn image_version(flag: Option<String>) -> Result<String, Error> {
    let raw = flag
        .or_else(|| version().map(String::from))
        .ok_or("未指定镜像版本：请用 --image-version vX.Y.Z（开发构建没有内置版本号）。")?;
    let v = raw.strip_prefix('v').unwrap_or(&raw);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let numeric = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let pre_ok = pre
        .is_none_or(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.'));
    if !numeric || !pre_ok {
        return Err("版本必须是 vX.Y.Z，或预发布版本 vX.Y.Z-rc.N。".into());
    }
    Ok(v.to_string())
}

/// `text` without the line setting `key`.
fn without_env(text: &str, key: &str) -> String {
    let prefix = format!("{key}=");
    text.split_inclusive('\n')
        .filter(|line| !line.starts_with(&prefix))
        .collect()
}
/// `text` with the line setting `key` replaced; the key must already be there.
fn with_env(text: &str, key: &str, value: &str) -> Result<String, Error> {
    let prefix = format!("{key}=");
    let mut found = false;
    let mut out = String::new();
    for line in text.split_inclusive('\n') {
        if line.starts_with(&prefix) {
            found = true;
            out.push_str(&env_line(key, value)?);
        } else {
            out.push_str(line);
        }
    }
    if found {
        Ok(out)
    } else {
        Err(format!(".env 里没有 {key}，这不是 willcord main init 生成的部署目录。").into())
    }
}
/// The value of `key` in an env file written by `env_line`.
fn env_value(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=\"");
    let line = text.lines().find(|l| l.starts_with(&prefix))?;
    let inner = line[prefix.len()..].strip_suffix('"')?;
    let mut out = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, chars.peek()) {
            ('\\', Some(&n)) => {
                out.push(n);
                chars.next();
            }
            ('$', Some('$')) => {
                out.push('$');
                chars.next();
            }
            _ => out.push(c),
        }
    }
    Some(out)
}

// ------------------------------------------------------------ environment

/// Whether to show the macOS hints. Debug builds let tests choose.
fn is_macos() -> bool {
    #[cfg(debug_assertions)]
    if let Ok(os) = std::env::var("WILLCORD_TEST_OS") {
        return os == "Darwin";
    }
    cfg!(target_os = "macos")
}

fn docker_missing(e: std::io::Error) -> Error {
    if e.kind() == std::io::ErrorKind::NotFound {
        "缺少 docker，请安装后重试。".into()
    } else {
        e.into()
    }
}
fn compose(dir: &Path, args: &[&str]) -> Result<(), Error> {
    let status = Command::new("docker")
        .arg("compose")
        .args(args)
        .current_dir(dir)
        .status()
        .map_err(docker_missing)?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("docker compose {} 失败（{status}）。", args.join(" ")).into())
    }
}
fn compose_quiet(dir: &Path, args: &[&str]) -> bool {
    Command::new("docker")
        .arg("compose")
        .args(args)
        .current_dir(dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Where `main init` leaves the path of the deployment it made, so the day-to-day
/// commands work from any directory. Kept apart from a worker's data directory,
/// which `worker uninstall --delete-data` removes whole.
fn remembered_file() -> Option<PathBuf> {
    let base = match std::env::var_os("WILLCORD_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".config/willcord"),
    };
    base.is_absolute().then(|| base.join("main-dir"))
}
fn remember(dir: &Path) -> Result<(), Error> {
    let file = remembered_file().ok_or("HOME required")?;
    crate::cli::private_dir(file.parent().ok_or("no parent")?)?;
    crate::cli::save(&file, dir.to_string_lossy().as_bytes())
}
fn remembered() -> Option<PathBuf> {
    let text = fs::read_to_string(remembered_file()?).ok()?;
    let dir = PathBuf::from(text.trim());
    dir.is_absolute().then_some(dir)
}
/// The first of these that holds a compose.yaml, in order of how deliberate the
/// choice was: the directory this binary sits in, the current one, the last one
/// `main init` made.
fn find_deployment(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|c| c.join("compose.yaml").is_file())
}
/// A deployment directory: `--dir`, else where this binary or the shell already
/// is, else the one `main init` last made.
fn deployment_dir(args: &mut Vec<String>) -> Result<PathBuf, Error> {
    if let Some(dir) = take_value(args, "--dir")? {
        let dir = PathBuf::from(dir);
        if !dir.join("compose.yaml").is_file() {
            return Err(format!("{} 里没有 compose.yaml。", dir.display()).into());
        }
        return Ok(dir);
    }
    let beside = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(Path::to_path_buf));
    let local = beside.into_iter().chain(std::env::current_dir().ok());
    if let Some(dir) = find_deployment(local) {
        return Ok(dir);
    }
    match remembered() {
        Some(dir) if dir.join("compose.yaml").is_file() => Ok(dir),
        Some(dir) => Err(format!(
            "上次部署的目录 {} 已经不在了（没有 compose.yaml）：用 --dir 指定新的位置。",
            dir.display()
        )
        .into()),
        None => Err(
            "找不到部署目录（没有 compose.yaml）：请用 --dir 指定，或先运行 willcord main init。"
                .into(),
        ),
    }
}

enum Health {
    Ready,
    NotReady,
    Unreachable(String),
}
/// Ask `/health` over HTTPS, trusting only the deployment's own CA.
async fn health(server: &str, ca: &Path) -> Health {
    let probe = async {
        let cert = reqwest::Certificate::from_pem(&fs::read(ca)?)?;
        // Only this deployment's CA: a publicly trusted certificate on the same
        // origin (another service, a proxy) must not pass for the main node, and a
        // redirect must not carry the probe to a host the CA never vouched for.
        let client = reqwest::Client::builder()
            .tls_built_in_root_certs(false)
            .add_root_certificate(cert)
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()?;
        let body: Value = client
            .get(format!("{server}/health"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        Ok::<bool, Error>(body["scheduling_ready"] == true)
    };
    match probe.await {
        Ok(true) => Health::Ready,
        Ok(false) => Health::NotReady,
        Err(e) => Health::Unreachable(e.to_string()),
    }
}
async fn wait_ready(dir: &Path, server: &str, fetch_ca: bool) -> bool {
    for _ in 0..60 {
        let ca = dir.join("ca.pem");
        let have_ca = !fetch_ca
            || compose_quiet(
                dir,
                &[
                    "cp",
                    "caddy:/data/caddy/pki/authorities/local/root.crt",
                    "./ca.pem",
                ],
            );
        if have_ca && matches!(health(server, &ca).await, Health::Ready) {
            return true;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    false
}

// ------------------------------------------------------------------ prompts

struct Tty(fs::File);
impl Tty {
    fn open() -> Result<Tty, Error> {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/tty")
            .map(Tty)
            .map_err(|_| "初始化需要交互终端 /dev/tty。".into())
    }
    /// Echo is switched off before a secret is requested, so even a fast paste
    /// never shows; the guard restores the terminal on every exit path.
    fn prompt(&mut self, label: &str, fallback: &str, secret: bool) -> Result<String, Error> {
        struct Echo(i32, libc::termios);
        impl Drop for Echo {
            fn drop(&mut self) {
                unsafe { libc::tcsetattr(self.0, libc::TCSANOW, &self.1) };
            }
        }
        let fd = self.0.as_raw_fd();
        let _echo = if secret {
            let mut state: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut state) } == 0 {
                let saved = state;
                state.c_lflag &= !libc::ECHO;
                unsafe { libc::tcsetattr(fd, libc::TCSANOW, &state) };
                Some(Echo(fd, saved))
            } else {
                None
            }
        } else {
            None
        };
        if fallback.is_empty() {
            write!(self.0, "{label}: ")?;
        } else {
            write!(self.0, "{label} [{fallback}]: ")?;
        }
        self.0.flush()?;
        // One byte at a time: nothing past the newline may be consumed.
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            if self.0.read(&mut byte)? == 0 {
                if line.is_empty() {
                    return Err("输入已取消。".into());
                }
                break;
            }
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        if secret {
            writeln!(self.0)?;
        }
        let line = String::from_utf8_lossy(&line);
        let line = line.trim_end_matches('\r');
        Ok(if line.is_empty() { fallback } else { line }.to_string())
    }
}

// --------------------------------------------------------------------- init

/// Show how the root certificate is trusted on this machine; the browser and
/// every worker need it unless the certificate is publicly trusted.
fn trust_hint(ca: &Path) {
    let quoted = shell_quote(ca);
    if is_macos() {
        println!(
            "信任根证书（macOS，需要管理员密码）：\n  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain {quoted}"
        );
        println!("然后重启浏览器。也可以双击 ca.pem，在“钥匙串访问”里把它设为“始终信任”。");
    } else {
        println!(
            "信任根证书（Debian/Ubuntu）：\n  sudo cp {quoted} /usr/local/share/ca-certificates/willcord-ca.crt && sudo update-ca-certificates"
        );
        println!(
            "其他发行版请把它加入系统信任库；Firefox 需要在“设置 → 证书 → 查看证书 → 证书颁发机构”里单独导入。"
        );
    }
    println!("执行机器用“添加机器”里的命令安装时会自动获取并核对 CA，无需单独信任。");
}

fn create_new(path: &Path, content: &str) -> Result<(), Error> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(content.as_bytes())?;
    Ok(())
}

/// Where the main node is reached from: the addresses found on this machine
/// are offered by number, and anything else typed must be a full HTTPS origin.
fn choose_server(tty: &mut Tty) -> Result<String, Error> {
    let found = netaddr::candidates();
    let offered: Vec<String> = found
        .iter()
        .map(|c| format!("https://{}:{DEFAULT_PORT}", c.address))
        .collect();
    if offered.is_empty() {
        return tty.prompt("浏览器和 worker 可访问的 HTTPS 地址", DEFAULT_SERVER, false);
    }
    println!("检测到本机地址（浏览器和 worker 须能访问）：");
    for (n, (url, c)) in offered.iter().zip(&found).enumerate() {
        let overlay = c.overlay.map(|k| format!("（{k}）")).unwrap_or_default();
        println!("  {}) {url}   {}{overlay}", n + 1, c.interface);
    }
    println!("动态分配（DHCP）的 IP 换网络后会变，长期使用建议改用固定 IP 或域名。");
    let answer = tty.prompt(
        "服务地址（输入序号，或完整 https:// 地址）",
        &offered[0],
        false,
    )?;
    pick_server(&answer, &offered)
}

/// A number picks from the offered list; anything else is taken as typed.
fn pick_server(answer: &str, offered: &[String]) -> Result<String, Error> {
    let answer = answer.trim();
    if !answer.is_empty() && answer.bytes().all(|b| b.is_ascii_digit()) {
        return match answer.parse::<usize>() {
            Ok(n) if (1..=offered.len()).contains(&n) => Ok(offered[n - 1].clone()),
            _ => Err(format!("没有序号 {answer}，可选 1–{}。", offered.len()).into()),
        };
    }
    Ok(answer.to_string())
}

async fn init(mut args: Vec<String>) -> Result<(), Error> {
    let dir = take_value(&mut args, "--dir")?.unwrap_or_else(|| "willcord".into());
    let server_flag = take_value(&mut args, "--server")?;
    let version_flag = take_value(&mut args, "--image-version")?;
    if let Some(extra) = args.first() {
        return Err(format!("未知参数：{extra}\n{MAIN_USAGE}").into());
    }
    let version = image_version(version_flag)?;
    let docker = |args: &[&str]| {
        Command::new("docker")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(docker_missing)
            .map(|s| s.success())
    };
    if !docker(&["compose", "version"])? {
        return Err("请先安装 Docker Compose v2。".into());
    }
    if !docker(&["info"])? {
        return Err("无法访问 Docker，请检查 Docker 服务及当前账户权限。".into());
    }
    let mut tty = Tty::open()?;
    let dir = PathBuf::from(dir);
    fs::create_dir_all(&dir)?;
    let dir = fs::canonicalize(&dir)?;
    for existing in ["compose.yaml", ".env", "main.env", "ca.pem"] {
        if fs::symlink_metadata(dir.join(existing)).is_ok() {
            return Err(format!("目录已有 {existing}，拒绝覆盖，请使用新的 --dir。").into());
        }
    }
    let server = match server_flag {
        Some(s) => s,
        None => choose_server(&mut tty)?,
    };
    let origin = parse_origin(&server)?;
    let password = tty.prompt("首次管理员密码（至少 16 字符）", "", true)?;
    if password.chars().count() < 16 {
        return Err("管理员密码至少需要 16 字符。".into());
    }
    // Exclusive creation also protects against another initializer racing us.
    create_new(&dir.join("compose.yaml"), COMPOSE)?;
    create_new(
        &dir.join(".env"),
        &[
            env_line("COMPOSE_PROJECT_NAME", &project_name(&dir))?,
            env_line("WILLCORD_VERSION", &version)?,
            env_line("WILLCORD_SITE", &origin.site)?,
            env_line("WILLCORD_PORT", &origin.port.to_string())?,
        ]
        .concat(),
    )?;
    create_new(
        &dir.join("main.env"),
        &[
            env_line("PUBLIC_BASE_URL", &origin.server)?,
            env_line("INITIAL_ADMIN_PASSWORD", &password)?,
        ]
        .concat(),
    )?;
    drop(password);
    println!("部署目录：{}", dir.display());
    // From here on, keep the files and volumes if startup fails.
    if let Err(e) = start(&dir, &origin.server).await {
        eprintln!("{RECOVERY}");
        return Err(e);
    }
    // Keep a copy of this binary beside the deployment, and remember where the
    // deployment is, so `willcord main status` works from any directory.
    let beside = dir.join("willcord");
    if std::env::current_exe().ok().as_deref() != Some(beside.as_path()) {
        if let Ok(exe) = std::env::current_exe() {
            let _ = fs::copy(exe, &beside)
                .and_then(|_| fs::set_permissions(&beside, fs::Permissions::from_mode(0o755)));
        }
    }
    if let Err(e) = remember(&dir) {
        eprintln!("提示：没能记住部署目录（{e}）；之后的 willcord main 命令请加 --dir。");
    }
    println!(
        "\n主节点已就绪：{}\n根证书：{}/ca.pem",
        origin.server,
        dir.display()
    );
    let command = crate::path_install::ensure(crate::path_install::Scope::User, &beside);
    println!("\n下一步：\n1. 让浏览器信任根证书，否则控制台会提示证书不安全。");
    trust_hint(&dir.join("ca.pem"));
    println!(
        "2. 打开 {} 登录，在侧栏“模型连接”绑定模型 API key；未绑定前任务无法执行。",
        origin.server
    );
    println!("3. 在“机器授权 → 添加机器”复制安装命令，到执行机器上运行。");
    println!(
        "日常管理（在任意目录）：{command} main status | logs | down | up | upgrade --image-version vX.Y.Z"
    );
    if is_macos() {
        println!(
            "提示：macOS 上的主节点依赖 Docker Desktop，适合本机试用；Docker Desktop 退出后服务随之停止，生产环境请使用 Linux。"
        );
    }
    Ok(())
}

async fn start(dir: &Path, server: &str) -> Result<(), Error> {
    compose(dir, &["pull"])?;
    compose(dir, &["up", "-d"])?;
    if !wait_ready(dir, server, true).await {
        return Err("HTTPS 未就绪。检查主机名解析、端口和 docker compose logs main caddy。".into());
    }
    fs::set_permissions(dir.join("ca.pem"), fs::Permissions::from_mode(0o644))?;
    // The first password is only needed once: drop it and restart main.
    let main_env = dir.join("main.env");
    let text = fs::read_to_string(&main_env)?;
    fs::write(&main_env, without_env(&text, "INITIAL_ADMIN_PASSWORD"))?;
    compose(dir, &["up", "-d", "main"])?;
    if !wait_ready(dir, server, false).await {
        return Err("移除首次密码后的主节点未就绪，请查看 docker compose logs main。".into());
    }
    Ok(())
}

// ----------------------------------------------------------- day-to-day

fn run_in_deployment(mut args: Vec<String>, compose_args: &[&str]) -> Result<(), Error> {
    let dir = deployment_dir(&mut args)?;
    if let Some(extra) = args.first() {
        return Err(format!("未知参数：{extra}\n{MAIN_USAGE}").into());
    }
    compose(&dir, compose_args)
}

fn logs(mut args: Vec<String>) -> Result<(), Error> {
    let dir = deployment_dir(&mut args)?;
    let mut compose_args = vec!["logs"];
    compose_args.extend(args.iter().map(String::as_str));
    compose(&dir, &compose_args)
}

fn deployment_server(dir: &Path) -> Result<String, Error> {
    let text = fs::read_to_string(dir.join("main.env"))?;
    env_value(&text, "PUBLIC_BASE_URL").ok_or_else(|| "main.env 里没有 PUBLIC_BASE_URL。".into())
}

async fn status(mut args: Vec<String>) -> Result<(), Error> {
    let dir = deployment_dir(&mut args)?;
    if let Some(extra) = args.first() {
        return Err(format!("未知参数：{extra}\n{MAIN_USAGE}").into());
    }
    compose(&dir, &["ps"])?;
    let server = deployment_server(&dir)?;
    match health(&server, &dir.join("ca.pem")).await {
        Health::Ready => {
            println!("主节点已就绪：{server}");
            Ok(())
        }
        Health::NotReady => Err(format!("{server} 可以访问，但调度尚未就绪（/health 的 scheduling_ready 为 false）。查看 willcord main logs。").into()),
        Health::Unreachable(why) => Err(format!("无法通过 HTTPS 访问 {server}/health：{why}").into()),
    }
}

async fn upgrade(mut args: Vec<String>) -> Result<(), Error> {
    let dir = deployment_dir(&mut args)?;
    let version = image_version(take_value(&mut args, "--image-version")?)?;
    if let Some(extra) = args.first() {
        return Err(format!("未知参数：{extra}\n{MAIN_USAGE}").into());
    }
    let env = dir.join(".env");
    let updated = with_env(&fs::read_to_string(&env)?, "WILLCORD_VERSION", &version)?;
    fs::write(&env, updated)?;
    println!("镜像版本：{version}");
    compose(&dir, &["pull"])?;
    compose(&dir, &["up", "-d"])?;
    let server = deployment_server(&dir)?;
    if !wait_ready(&dir, &server, false).await {
        return Err("升级后主节点未就绪，请查看 willcord main logs。回滚时把 .env 里的 WILLCORD_VERSION 改回旧值，再执行 willcord main up；数据库迁移不可逆，需要旧版本的 admin restore（见 docs/operations.md）。".into());
    }
    println!("主节点已就绪：{server}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_nearest_deployment_wins() {
        let root = std::env::temp_dir().join(format!("wc-find-{}", uuid::Uuid::new_v4()));
        let (a, b, none) = (root.join("a"), root.join("b"), root.join("none"));
        for d in [&a, &b, &none] {
            fs::create_dir_all(d).unwrap();
        }
        for d in [&a, &b] {
            fs::write(d.join("compose.yaml"), "").unwrap();
        }
        assert_eq!(
            find_deployment([none.clone(), b.clone(), a.clone()]),
            Some(b.clone())
        );
        assert_eq!(find_deployment([none.clone()]), None);
        assert_eq!(find_deployment([]), None);
        // A directory named compose.yaml is not a deployment.
        fs::create_dir_all(none.join("compose.yaml")).unwrap();
        assert_eq!(find_deployment([none, a.clone()]), Some(a));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn origins_are_normalised_and_bounded() {
        let o = parse_origin("https://Plane.Internal:8443/").unwrap();
        assert_eq!(o.site, "plane.internal:8443");
        assert_eq!(o.server, "https://plane.internal:8443");
        assert_eq!(o.port, 8443);
        let o = parse_origin("https://plane.internal").unwrap();
        assert_eq!(
            (o.site.as_str(), o.server.as_str(), o.port),
            ("plane.internal:443", "https://plane.internal", 443)
        );
        let o = parse_origin("https://[fd00::1]:9443").unwrap();
        assert_eq!(
            (o.site.as_str(), o.server.as_str()),
            ("[fd00::1]:9443", "https://[fd00::1]:9443")
        );
        let o = parse_origin("https://127.0.0.1:8443").unwrap();
        assert_eq!(o.site, "127.0.0.1:8443");
        for bad in [
            "http://plane.internal",
            "plane.internal",
            "https://",
            "https://:8443",
            "https://plane.internal/path",
            "https://user@plane.internal",
            "https://plane.internal?x=1",
            "https://plane.internal:",
            "https://plane.internal:80a",
            "https://plane.internal:0",
            "https://plane.internal:65536",
            "https://plane.internal:123456",
            "https://-plane.internal",
            "https://[]:8443",
            "https://[fd00::1",
            "https://[fd00::1]/health",
            "https://[fd00::1]x",
            "https://[fd00::1]?x=1",
            "https://[fd00::1]:",
            "https://plane.internal//",
        ] {
            assert!(parse_origin(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn env_lines_survive_compose_and_round_trip() {
        assert_eq!(
            env_line("K", "a\"b\\c$d#e'f").unwrap(),
            "K=\"a\\\"b\\\\c$$d#e'f\"\n"
        );
        assert!(env_line("K", "one\ntwo").is_err());
        assert!(env_line("K", "one\rtwo").is_err());
        for value in ["plain", "key$with#special", "q\"uote\\back", "$$", ""] {
            let line = env_line("K", value).unwrap();
            assert_eq!(env_value(&line, "K").as_deref(), Some(value), "{value}");
        }
    }

    #[test]
    fn env_files_are_edited_by_key() {
        let text = "A=\"1\"\nINITIAL_ADMIN_PASSWORD=\"secret\"\nINITIAL_ADMIN_PASSWORD_HINT=\"keep\"\nB=\"2\"\n";
        // Only the exact key goes; a longer key sharing the prefix stays.
        assert_eq!(
            without_env(text, "INITIAL_ADMIN_PASSWORD"),
            "A=\"1\"\nINITIAL_ADMIN_PASSWORD_HINT=\"keep\"\nB=\"2\"\n"
        );
        assert_eq!(
            with_env(
                "A=\"1\"\nWILLCORD_VERSION=\"0.4.2\"\n",
                "WILLCORD_VERSION",
                "0.5.0"
            )
            .unwrap(),
            "A=\"1\"\nWILLCORD_VERSION=\"0.5.0\"\n"
        );
        assert!(with_env("A=\"1\"\n", "WILLCORD_VERSION", "0.5.0").is_err());
    }

    #[test]
    fn project_names_are_stable_per_directory() {
        // printf '%s' /tmp/willcord-test | shasum -a 256 | cut -c1-12
        assert_eq!(
            project_name(Path::new("/tmp/willcord-test")),
            "willcord-ac340ae4ef3a"
        );
        assert_ne!(
            project_name(Path::new("/tmp/a")),
            project_name(Path::new("/tmp/b"))
        );
    }

    #[test]
    fn image_versions_are_released_or_prerelease_tags() {
        assert_eq!(image_version(Some("v1.2.3".into())).unwrap(), "1.2.3");
        assert_eq!(
            image_version(Some("1.2.3-rc.1".into())).unwrap(),
            "1.2.3-rc.1"
        );
        for bad in [
            "v1.2",
            "v1.2.3-",
            "v1.2.3-rc 1",
            "latest",
            "v1.2.x",
            "v1..3",
        ] {
            assert!(image_version(Some(bad.into())).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_number_picks_a_detected_address_and_anything_else_is_kept() {
        let offered = vec![
            "https://192.168.1.5:8443".to_string(),
            "https://10.8.0.2:8443".to_string(),
        ];
        assert_eq!(pick_server("2", &offered).unwrap(), offered[1]);
        assert_eq!(pick_server(" 1 ", &offered).unwrap(), offered[0]);
        assert_eq!(
            pick_server("https://plane.example.com", &offered).unwrap(),
            "https://plane.example.com"
        );
        for bad in ["0", "3", "99999999999999999999"] {
            assert!(pick_server(bad, &offered).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_embedded_compose_file_is_the_deployed_one() {
        assert!(COMPOSE.contains("WILLCORD_VERSION:?set WILLCORD_VERSION"));
        assert!(COMPOSE.contains("willcord-main"));
    }
}
