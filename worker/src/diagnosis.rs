// Diagnosis-mode execution policy (O2-KR1). Enforced on the worker before any
// write hits disk or bash spawns a process.

const MAX_DU_DEPTH: u64 = 5;

/// Refuse every write while the session is in diagnosis mode.
pub fn write_allowed(execution_mode: Option<&str>) -> bool {
    execution_mode != Some("diagnosis")
}

/// Validated argv for direct exec (no shell). Diagnosis mode must use this path.
pub fn bash_argv(command: &str) -> Result<Vec<String>, &'static str> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("diagnosis_bash_empty: 诊断模式 bash 命令不能为空");
    }
    let tokens: Vec<String> = trimmed.split_whitespace().map(|s| s.to_owned()).collect();
    if tokens.is_empty() {
        return Err("diagnosis_bash_empty: 诊断模式 bash 命令不能为空");
    }
    for token in &tokens {
        reject_token_metacharacters(token)?;
    }
    let argv = match tokens[0].as_str() {
        "docker" => {
            allow_docker(&tokens)?;
            tokens
        }
        "df" => {
            allow_df(&tokens)?;
            tokens
        }
        "du" => {
            allow_du(&tokens)?;
            tokens
        }
        "systemctl" => {
            allow_systemctl(&tokens)?;
            tokens
        }
        "curl" => {
            allow_curl(&tokens)?;
            let mut argv = vec!["curl".to_owned(), "-q".to_owned(), "--globoff".to_owned()];
            argv.extend(tokens.into_iter().skip(1));
            argv
        }
        "id" => {
            allow_id(&tokens)?;
            tokens
        }
        "ls" => {
            allow_ls(&tokens)?;
            tokens
        }
        "pwd" => {
            allow_pwd(&tokens)?;
            tokens
        }
        "true" => {
            allow_true(&tokens)?;
            tokens
        }
        _ => {
            return Err(
                "diagnosis_bash_not_allowlisted: 命令不在诊断只读白名单内（允许: docker、df、du、systemctl status、curl、id、ls、pwd、true）",
            );
        }
    };
    Ok(argv)
}

const HOST_OS_RELEASE_PATH: &str = "/etc/os-release";
const HOST_READ_LIMIT: usize = 256 * 1024;

/// Read-only host paths reachable via the `read` tool in diagnosis mode (not workspace-relative).
pub fn read_host_file(path: &str) -> Result<Vec<u8>, &'static str> {
    if path != HOST_OS_RELEASE_PATH {
        return Err(
            "diagnosis_read_host_path_not_allowed: 诊断模式仅允许读取主机路径 /etc/os-release；工作目录内请用相对路径",
        );
    }
    read_host_os_release(HOST_OS_RELEASE_PATH)
}

/// `/etc/os-release` is usually a symlink; follow it but only accept known distro targets.
fn read_host_os_release(requested: &str) -> Result<Vec<u8>, &'static str> {
    use std::ffi::CString;
    use std::io::Read;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    let path = CString::new(requested)
        .map_err(|_| "diagnosis_read_host_open_failed: 无法打开 /etc/os-release")?;
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err("diagnosis_read_host_open_failed: 无法打开 /etc/os-release");
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let meta = file
        .metadata()
        .map_err(|_| "diagnosis_read_host_open_failed: 无法打开 /etc/os-release")?;
    if !meta.is_file() {
        return Err("diagnosis_read_host_open_failed: 无法打开 /etc/os-release");
    }
    if meta.size() as usize > HOST_READ_LIMIT {
        return Err("diagnosis_read_host_read_failed: 读取 /etc/os-release 失败");
    }
    let proc_fd = format!("/proc/self/fd/{}", file.as_raw_fd());
    let canonical = std::fs::canonicalize(&proc_fd)
        .map_err(|_| "diagnosis_read_host_open_failed: 无法打开 /etc/os-release")?;
    if !allowed_os_release_target(&canonical) {
        return Err(
            "diagnosis_read_host_path_not_allowed: 诊断模式仅允许读取主机路径 /etc/os-release；工作目录内请用相对路径",
        );
    }
    let mut bytes = Vec::new();
    file.take(HOST_READ_LIMIT as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "diagnosis_read_host_read_failed: 读取 /etc/os-release 失败")?;
    Ok(bytes)
}

fn allowed_os_release_target(canonical: &std::path::Path) -> bool {
    let name = canonical.file_name().and_then(|n| n.to_str());
    if name != Some("os-release") && name != Some("os-release-dist") {
        return false;
    }
    match canonical.parent().and_then(|p| p.to_str()) {
        Some("/etc") | Some("/usr/lib") | Some("/usr/lib/rpm") => true,
        _ => false,
    }
}

fn reject_token_metacharacters(token: &str) -> Result<(), &'static str> {
    if token.starts_with('@') {
        return Err("invalid");
    }
    if token.starts_with("http://") || token.starts_with("https://") {
        if token.contains('\\') || token.contains('@') {
            return Err("invalid");
        }
        return Ok(());
    }
    const FORBIDDEN: &[char] = &[
        '&', '\\', '$', '*', '?', '[', ']', '~', '{', '}', '!', '#', '|', ';', '\n', '\r', '`',
        '<', '>', '"', '\'',
    ];
    if token.chars().any(|c| FORBIDDEN.contains(&c)) {
        return Err("invalid");
    }
    Ok(())
}

fn allow_pwd(tokens: &[String]) -> Result<(), &'static str> {
    if tokens.len() == 1 && tokens[0] == "pwd" {
        Ok(())
    } else {
        Err("diagnosis_bash_pwd_only: 诊断模式仅允许单独的 pwd")
    }
}

fn allow_true(tokens: &[String]) -> Result<(), &'static str> {
    if tokens.len() == 1 && tokens[0] == "true" {
        Ok(())
    } else {
        Err("diagnosis_bash_true_only: 诊断模式仅允许单独的 true")
    }
}

fn allow_id(tokens: &[String]) -> Result<(), &'static str> {
    if tokens.is_empty() || tokens[0] != "id" {
        return Err("diagnosis_bash_not_allowlisted: id 命令格式无效");
    }
    for t in tokens.iter().skip(1) {
        if !t.starts_with('-') || t.len() < 2 {
            return Err("diagnosis_bash_id_flags: id 仅允许常见只读标志（如 -u、-g、-n）");
        }
        if !t.chars().skip(1).all(|c| c.is_ascii_alphabetic()) {
            return Err("diagnosis_bash_id_flags: id 仅允许常见只读标志（如 -u、-g、-n）");
        }
    }
    Ok(())
}

fn allow_ls(tokens: &[String]) -> Result<(), &'static str> {
    if tokens.is_empty() || tokens[0] != "ls" {
        return Err("diagnosis_bash_not_allowlisted: ls 命令格式无效");
    }
    for t in tokens.iter().skip(1) {
        if t.starts_with('-') {
            if !t
                .chars()
                .skip(1)
                .all(|c| c.is_ascii_alphabetic() || c == '-')
            {
                return Err("diagnosis_bash_ls_flags: ls 标志不在诊断只读白名单内");
            }
            continue;
        }
        if t.contains("..") {
            return Err("diagnosis_bash_path_traversal: 路径不得包含 ..");
        }
    }
    Ok(())
}

fn allow_docker(tokens: &[String]) -> Result<(), &'static str> {
    let sub = tokens.get(1).map(String::as_str);
    match sub {
        Some("ps") => Ok(()),
        Some("info") if tokens.len() == 2 => Ok(()),
        Some("inspect") if tokens.len() >= 3 => Ok(()),
        Some("logs") if tokens.len() >= 3 => reject_docker_logs_follow(tokens),
        Some("container") => match tokens.get(2).map(String::as_str) {
            Some("ps") | Some("inspect") if tokens.len() >= 3 => Ok(()),
            Some("logs") if tokens.len() >= 4 => reject_docker_logs_follow(tokens),
            _ => Err("invalid"),
        },
        _ => Err("invalid"),
    }
}

fn allow_df(tokens: &[String]) -> Result<(), &'static str> {
    if tokens[0] != "df" {
        return Err("invalid");
    }
    for t in tokens.iter().skip(1) {
        if t.starts_with('-') {
            if !t
                .chars()
                .skip(1)
                .all(|c| c.is_ascii_alphabetic() || c == '-')
            {
                return Err("invalid");
            }
            continue;
        }
        if t.contains("..") {
            return Err("invalid");
        }
    }
    Ok(())
}

fn allow_du(tokens: &[String]) -> Result<(), &'static str> {
    if tokens[0] != "du" {
        return Err("invalid");
    }
    let mut summary_only = false;
    let mut depth_ok = false;
    let mut i = 1;
    while i < tokens.len() {
        let t = &tokens[i];
        if t == "-s" || t == "--summarize" || t == "-sh" || t == "-hs" {
            summary_only = true;
            i += 1;
            continue;
        }
        if t.starts_with('-')
            && !t.starts_with("--")
            && t.chars().skip(1).all(|c| c == 's' || c == 'h')
            && t.contains('s')
        {
            summary_only = true;
            i += 1;
            continue;
        }
        if t.starts_with("--max-depth=") {
            let depth = t["--max-depth=".len()..]
                .parse::<u64>()
                .map_err(|_| "invalid")?;
            if depth == 0 || depth > MAX_DU_DEPTH {
                return Err("invalid");
            }
            depth_ok = true;
            i += 1;
            continue;
        }
        if t == "-a" || t == "--all" {
            i += 1;
            continue;
        }
        if t == "-X" {
            return Err("invalid");
        }
        if t.starts_with("--") && (t.contains("-from") || t.starts_with("--exclude-from")) {
            return Err("invalid");
        }
        if t == "-d" {
            let depth = tokens
                .get(i + 1)
                .ok_or("invalid")?
                .parse::<u64>()
                .map_err(|_| "invalid")?;
            if depth == 0 || depth > MAX_DU_DEPTH {
                return Err("invalid");
            }
            depth_ok = true;
            i += 2;
            continue;
        }
        if let Some(rest) = t.strip_prefix("-d") {
            if rest.is_empty() {
                return Err("invalid");
            }
            let depth = rest.parse::<u64>().map_err(|_| "invalid")?;
            if depth == 0 || depth > MAX_DU_DEPTH {
                return Err("invalid");
            }
            depth_ok = true;
            i += 1;
            continue;
        }
        if t.starts_with('-') {
            if t.starts_with("--") {
                return Err("invalid");
            }
            if t.chars().skip(1).any(|c| c == 'X') {
                return Err("invalid");
            }
            if t.chars().skip(1).all(|c| c == 'a' || c == 's' || c == 'h') {
                if t.contains('s') {
                    summary_only = true;
                }
                i += 1;
                continue;
            }
            return Err("invalid");
        }
        if t.contains("..") {
            return Err("invalid");
        }
        i += 1;
    }
    if summary_only || depth_ok {
        Ok(())
    } else {
        Err("invalid")
    }
}

fn allow_systemctl(tokens: &[String]) -> Result<(), &'static str> {
    if tokens.len() != 3 || tokens[1] != "status" {
        return Err("invalid");
    }
    let unit = &tokens[2];
    if unit.is_empty() || unit.starts_with('-') {
        return Err("invalid");
    }
    Ok(())
}

fn reject_docker_logs_follow(tokens: &[String]) -> Result<(), &'static str> {
    let start = if tokens.get(1).map(String::as_str) == Some("logs") {
        2
    } else if tokens.get(1).map(String::as_str) == Some("container")
        && tokens.get(2).map(String::as_str) == Some("logs")
    {
        3
    } else {
        return Err("invalid");
    };
    for t in tokens.iter().skip(start) {
        if t == "-f" || t == "--follow" || t.starts_with("--follow=") {
            return Err("invalid");
        }
        if t.starts_with('-') && !t.starts_with("--") && t.chars().skip(1).any(|c| c == 'f') {
            return Err("invalid");
        }
    }
    Ok(())
}

fn allow_curl(tokens: &[String]) -> Result<(), &'static str> {
    if tokens[0] != "curl" {
        return Err("invalid");
    }
    for t in tokens.iter().skip(1) {
        if *t == "-q" || *t == "--globoff" {
            return Err("invalid");
        }
        if t.starts_with('-') && !t.starts_with("--") && t.chars().skip(1).any(|c| c == 'q') {
            return Err("invalid");
        }
    }
    let mut urls = 0usize;
    let mut i = 1usize;
    while i < tokens.len() {
        let t = &tokens[i];
        if t.starts_with('-') {
            consume_curl_flag(tokens, &mut i)?;
            continue;
        }
        if urls > 0 {
            return Err("invalid");
        }
        parse_loopback_health_url(t)?;
        urls += 1;
        i += 1;
    }
    if urls == 1 { Ok(()) } else { Err("invalid") }
}

/// Read-only curl flags for a single local health GET. Anything else is refused.
fn consume_curl_flag(tokens: &[String], i: &mut usize) -> Result<(), &'static str> {
    let flag = tokens[*i].as_str();
    if flag == "-" {
        return Err("invalid");
    }
    if flag.starts_with("--") {
        match flag {
            "--fail" | "--silent" | "--show-error" | "--ipv4" | "--ipv6" => {
                *i += 1;
                Ok(())
            }
            "--max-time" | "--connect-timeout" | "--header" | "--user-agent" => {
                *i += 1;
                let value = tokens
                    .get(*i)
                    .filter(|v| !v.starts_with('-'))
                    .ok_or("invalid")?;
                reject_curl_flag_value(value)?;
                *i += 1;
                Ok(())
            }
            _ => Err("invalid"),
        }
    } else if flag.starts_with('-') {
        let mut needs_value = false;
        for ch in flag.chars().skip(1) {
            match ch {
                'f' | 's' | 'S' | '4' | '6' => {}
                'm' | 'H' | 'A' => needs_value = true,
                _ => return Err("invalid"),
            }
        }
        *i += 1;
        if needs_value {
            let value = tokens
                .get(*i)
                .filter(|v| !v.starts_with('-'))
                .ok_or("invalid")?;
            reject_curl_flag_value(value)?;
            *i += 1;
        }
        Ok(())
    } else {
        Err("invalid")
    }
}

fn parse_loopback_health_url(raw: &str) -> Result<(), &'static str> {
    if raw.contains('\\') || raw.contains('@') {
        return Err("invalid");
    }
    let parsed = url::Url::parse(raw).map_err(|_| "invalid")?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("invalid");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("invalid");
    }
    let ok = match parsed.host() {
        Some(url::Host::Domain(name)) => name.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(addr)) => addr == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(addr)) => addr == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    if ok { Ok(()) } else { Err("invalid") }
}

pub fn is_diagnosis(execution_mode: Option<&str>) -> bool {
    execution_mode == Some("diagnosis")
}

fn reject_curl_flag_value(value: &str) -> Result<(), &'static str> {
    if value.starts_with('@') {
        return Err("invalid");
    }
    Ok(())
}

/// True when argv is an allowed `docker inspect` invocation (output may contain secrets).
pub fn docker_inspect_argv(argv: &[String]) -> bool {
    match argv.first().map(String::as_str) {
        Some("docker") if argv.len() >= 3 => match argv.get(1).map(String::as_str) {
            Some("inspect") => true,
            Some("container") if argv.get(2).map(String::as_str) == Some("inspect") => true,
            _ => false,
        },
        _ => false,
    }
}

const REDACTED_ENV: &str = "<redacted>";
const INSPECT_WITHHELD: &str = r#"[{"_willcord_redaction":"truncated or incomplete docker inspect output; container environment values withheld"}]"#;

/// Remove container environment variables from `docker inspect` stdout before it is logged.
pub fn redact_docker_inspect_stdout(text: &str, output_was_truncated: bool) -> String {
    if output_was_truncated {
        return INSPECT_WITHHELD.to_string();
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return text.to_string();
    }
    match serde_json::from_str::<serde_json::Value>(trimmed) {
        Ok(mut value) => {
            redact_env_fields(&mut value);
            match serde_json::to_string(&value) {
                Ok(serialized) => serialized,
                Err(_) => INSPECT_WITHHELD.to_string(),
            }
        }
        Err(_) => INSPECT_WITHHELD.to_string(),
    }
}

fn redact_env_fields(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if key == "Env" {
                    *child = serde_json::Value::Array(vec![serde_json::Value::String(
                        REDACTED_ENV.to_owned(),
                    )]);
                } else {
                    redact_env_fields(child);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                redact_env_fields(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_os_release_targets_are_distro_paths_only() {
        use std::path::Path;
        assert!(allowed_os_release_target(Path::new("/usr/lib/os-release")));
        assert!(allowed_os_release_target(Path::new("/etc/os-release")));
        assert!(!allowed_os_release_target(Path::new("/etc/passwd")));
        assert!(!allowed_os_release_target(Path::new("/tmp/os-release")));
    }

    #[test]
    fn read_host_os_release_on_distro_hosts() {
        if !std::path::Path::new(HOST_OS_RELEASE_PATH).exists() {
            return;
        }
        let bytes = read_host_file(HOST_OS_RELEASE_PATH).expect("read /etc/os-release");
        assert!(!bytes.is_empty());
    }

    #[test]
    fn diagnosis_blocks_writes() {
        assert!(!write_allowed(Some("diagnosis")));
        assert!(write_allowed(None));
        assert!(write_allowed(Some("other")));
    }

    #[test]
    fn allowlisted_inspection_commands() {
        for cmd in [
            "docker ps",
            "docker ps -a",
            "docker inspect mysvc",
            "docker logs --tail 50 mysvc",
            "docker container ps",
            "df -h",
            "df -h /",
            "du -sh /var",
            "du -d 2 /var/log",
            "du --max-depth=3 /home",
            "du -a --max-depth=1 /var",
            "systemctl status nginx",
            "curl -fsS http://127.0.0.1/health",
            "curl http://localhost:8080/ready",
            "docker info",
            "id",
            "id -u",
            "ls -la /var",
            "pwd",
            "true",
        ] {
            assert!(bash_argv(cmd).is_ok(), "expected allow: {cmd}");
        }
    }

    #[test]
    fn forbidden_commands_never_run() {
        for cmd in [
            "docker restart web",
            "docker rm -f web",
            "docker compose up",
            "systemctl restart nginx",
            "rm -rf /",
            "chmod 777 /etc",
            "echo x > /tmp/out",
            "cat /etc/shadow",
            "apt-get install curl",
            "curl http://evil.example/health",
            "du /",
            "docker exec web ps",
            "bash -c 'docker ps'",
            "docker ps; docker restart x",
            "docker ps && docker restart x",
        ] {
            assert!(bash_argv(cmd).is_err(), "expected block: {cmd}");
        }
    }

    #[test]
    fn du_depth_is_capped() {
        assert_eq!(bash_argv("du -d 6 /var").unwrap_err(), "invalid");
        assert_eq!(bash_argv("du --max-depth=9 /var").unwrap_err(), "invalid");
    }

    #[test]
    fn curl_rejects_remote_and_prefix_url_tricks() {
        for cmd in [
            "curl http://127.0.0.1.evil.com/health",
            "curl http://localhost.attacker/ready",
            "curl http://user@127.0.0.1/health",
            "curl http://127.0.0.1@evil.example/health",
            "curl http://127.0.0.1\\@example.com/health",
            "curl http://127.0.0.2/health",
            "curl localhost:8080/ready",
            "curl -fsS http://127.0.0.1/health extra-arg",
            "curl -fsS http://127.0.0.1/a http://127.0.0.1/b",
        ] {
            assert!(bash_argv(cmd).is_err(), "expected block: {cmd}");
        }
        assert!(bash_argv("curl -fsS http://127.0.0.1/health").is_ok());
        assert!(bash_argv("curl http://[::1]/health").is_ok());
        assert!(bash_argv("curl https://[::1]:8080/healthz").is_ok());
    }

    #[test]
    fn qa_block_shell_and_allowlist_bypasses() {
        for cmd in [
            "docker ps & touch /tmp/pr75-pwned",
            "systemctl status nginx & systemctl restart nginx",
            "df -h & rm -rf /tmp/pr75-victim",
            "curl http://127.0.0.1\\@example.com/health",
            "du -sh /var/*",
            "docker ps $IFS",
        ] {
            assert_eq!(
                bash_argv(cmd).unwrap_err(),
                "invalid",
                "expected block: {cmd}"
            );
        }
    }

    #[test]
    fn systemctl_only_status_one_unit_no_remote_flags() {
        assert!(bash_argv("systemctl status nginx").is_ok());
        for cmd in [
            "systemctl status -H qa@172.30.0.2:2222 nginx",
            "systemctl status --host=qa@172.30.0.2:2222 nginx",
            "systemctl status nginx -Hqa@172.30.0.2:2222",
            "systemctl status -M qa@.host nginx",
            "systemctl status --machine=qa@.host nginx",
            "systemctl status --root / nginx",
            "systemctl status",
            "systemctl status -",
        ] {
            assert_eq!(
                bash_argv(cmd).unwrap_err(),
                "invalid",
                "expected block: {cmd}"
            );
        }
    }

    #[test]
    fn docker_logs_rejects_follow() {
        for cmd in [
            "docker logs -f web",
            "docker logs --follow web",
            "docker logs -sf web",
        ] {
            assert_eq!(
                bash_argv(cmd).unwrap_err(),
                "invalid",
                "expected block: {cmd}"
            );
        }
        assert!(bash_argv("docker logs --tail 20 web").is_ok());
    }

    #[test]
    fn curl_exec_argv_includes_forced_q_and_globoff() {
        let argv = bash_argv("curl -fsS http://127.0.0.1/health").unwrap();
        assert_eq!(
            argv,
            vec![
                "curl".to_owned(),
                "-q".to_owned(),
                "--globoff".to_owned(),
                "-fsS".to_owned(),
                "http://127.0.0.1/health".to_owned(),
            ]
        );
    }

    #[test]
    fn curl_rejects_header_and_data_file_indirection() {
        for cmd in [
            "curl -H @/etc/passwd http://127.0.0.1/health",
            "curl --header @/tmp/h http://127.0.0.1/health",
            "curl -H @headers.txt http://127.0.0.1/health",
        ] {
            assert_eq!(
                bash_argv(cmd).unwrap_err(),
                "invalid",
                "expected block: {cmd}"
            );
        }
    }

    #[test]
    fn du_rejects_file_backed_flags() {
        for cmd in [
            "du --exclude-from=/tmp/list -sh /var",
            "du -X /tmp/list -sh /var",
            "du --files0-from=/tmp/list -sh /var",
            "du -sh /var --exclude-from=/tmp/list",
        ] {
            assert_eq!(
                bash_argv(cmd).unwrap_err(),
                "invalid",
                "expected block: {cmd}"
            );
        }
    }

    #[test]
    fn docker_inspect_output_redacts_env() {
        let raw = r#"[{"Config":{"Env":["SECRET_TOKEN=abc","PATH=/usr/bin"],"Image":"x"}}]"#;
        let redacted = redact_docker_inspect_stdout(raw, false);
        assert!(!redacted.contains("SECRET_TOKEN"));
        assert!(redacted.contains(REDACTED_ENV));
        assert!(redacted.contains("\"Image\":\"x\""));
    }

    #[test]
    fn truncated_inside_env_array_does_not_leak_later_secrets() {
        let mut raw = String::from("[");
        for _ in 0..12 {
            raw.push_str(r#"{"Config":{"Env":["DB_PASSWORD=hunter2","MORE=x"]}},"#);
        }
        raw.push_str(r#"{"Config":{"Env":["DB_PASSWORD=hunter2","TAIL=x"#);
        let cut = raw.len() - 7;
        let truncated = raw[..cut].to_string();
        let redacted = redact_docker_inspect_stdout(&truncated, true);
        assert!(!redacted.contains("hunter2"));
    }

    #[test]
    fn truncated_after_env_null_does_not_leak_later_secrets() {
        let mut raw = String::from(r#"[{"Config":{"Env":null}},"#);
        for _ in 0..8 {
            raw.push_str(r#"{"Config":{"Env":["DB_PASSWORD=hunter2","MORE=x"]}},"#);
        }
        raw.push_str(r#"{"Config":{"Env":["DB_PASSWORD=hunter2","ZZZZZZZZZZ"#);
        let cut = raw.len() - 4;
        let truncated = raw[..cut].to_string();
        let redacted = redact_docker_inspect_stdout(&truncated, true);
        assert!(!redacted.contains("hunter2"));
    }

    #[test]
    fn truncated_env_bracket_inside_value_does_not_leak_later_secrets() {
        let raw =
            r#"[{"Config":{"Env":["REGEX=^a]","DB_PASSWORD=hunter2","TEST_FIXTURE_TOKEN=fake"#;
        let redacted = redact_docker_inspect_stdout(raw, true);
        assert!(!redacted.contains("hunter2"));
        assert!(!redacted.contains("TEST_FIXTURE_TOKEN=fake"));
        assert_eq!(redacted, INSPECT_WITHHELD);
    }

    #[test]
    fn truncated_secret_containing_bracket_does_not_leak_remainder() {
        let raw = r#"[{"Config":{"Env":["DB_PASSWORD=hun]ter2","TEST_FIXTURE_TOKEN=fake"#;
        let redacted = redact_docker_inspect_stdout(raw, true);
        assert!(!redacted.contains("ter2"));
        assert!(!redacted.contains("TEST_FIXTURE_TOKEN=fake"));
        assert_eq!(redacted, INSPECT_WITHHELD);
    }

    #[test]
    fn incomplete_json_without_truncation_flag_is_withheld() {
        let raw = r#"[{"Config":{"Env":["REGEX=^a]","DB_PASSWORD=hunter2"#;
        let redacted = redact_docker_inspect_stdout(raw, false);
        assert!(!redacted.contains("hunter2"));
        assert_eq!(redacted, INSPECT_WITHHELD);
    }

    #[test]
    fn curl_rejects_write_upload_and_config_flags() {
        for cmd in [
            "curl -o /tmp/out http://127.0.0.1/health",
            "curl --output /tmp/out http://127.0.0.1/health",
            "curl -O http://127.0.0.1/file",
            "curl -D /tmp/h http://127.0.0.1/health",
            "curl --trace /tmp/tr http://127.0.0.1/health",
            "curl -K /etc/curlrc http://127.0.0.1/health",
            "curl -T /etc/passwd http://127.0.0.1/health",
            "curl -d x http://127.0.0.1/health",
            "curl -F k=v http://127.0.0.1/health",
            "curl -c /tmp/c http://127.0.0.1/health",
            "curl -L http://127.0.0.1/health",
            "curl -X POST http://127.0.0.1/health",
        ] {
            assert!(bash_argv(cmd).is_err(), "expected block: {cmd}");
        }
    }
}
