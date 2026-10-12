// Diagnosis-mode execution policy (O2-KR1). Enforced on the worker before any
// write hits disk or bash spawns a process.

const MAX_DU_DEPTH: u64 = 5;

/// Refuse every write while the session is in diagnosis mode.
pub fn write_allowed(execution_mode: Option<&str>) -> bool {
    execution_mode != Some("diagnosis")
}

/// Bash is allowed only as a single, read-only inspection command from the
/// fixed allowlist below. Anything else is refused before exec.
pub fn bash_allowed(command: &str) -> Result<(), &'static str> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("invalid");
    }
    if trimmed.contains(['|', ';', '\n', '\r', '`']) {
        return Err("invalid");
    }
    if trimmed.contains("&&") || trimmed.contains("||") {
        return Err("invalid");
    }
    if trimmed.contains(['>', '<']) {
        return Err("invalid");
    }
    if trimmed.contains("$(") || trimmed.contains("${") {
        return Err("invalid");
    }

    let tokens = tokenize(trimmed)?;
    if tokens.is_empty() {
        return Err("invalid");
    }

    match tokens[0].as_str() {
        "docker" => allow_docker(&tokens),
        "df" => allow_df(&tokens),
        "du" => allow_du(&tokens),
        "systemctl" => allow_systemctl(&tokens),
        "curl" => allow_curl(&tokens),
        _ => Err("invalid"),
    }
}

fn tokenize(input: &str) -> Result<Vec<String>, &'static str> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escape = false;
    for ch in input.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' && quote == Some('"') {
            escape = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                out.push(current);
                current = String::new();
            }
            continue;
        }
        current.push(ch);
    }
    if quote.is_some() {
        return Err("invalid");
    }
    if !current.is_empty() {
        out.push(current);
    }
    Ok(out)
}

fn allow_docker(tokens: &[String]) -> Result<(), &'static str> {
    let sub = tokens.get(1).map(String::as_str);
    match sub {
        Some("ps") => Ok(()),
        Some("inspect") if tokens.len() >= 3 => Ok(()),
        Some("logs") if tokens.len() >= 3 => Ok(()),
        Some("container") => match tokens.get(2).map(String::as_str) {
            Some("ps") | Some("inspect") | Some("logs") if tokens.len() >= 3 => Ok(()),
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
            if !t
                .chars()
                .skip(1)
                .all(|c| c.is_ascii_alphabetic() || c == '-')
            {
                return Err("invalid");
            }
            i += 1;
            continue;
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
    if tokens.len() < 3 {
        return Err("invalid");
    }
    if tokens[1] != "status" {
        return Err("invalid");
    }
    Ok(())
}

fn allow_curl(tokens: &[String]) -> Result<(), &'static str> {
    if tokens[0] != "curl" {
        return Err("invalid");
    }
    let mut saw_url = false;
    for t in tokens.iter().skip(1) {
        if t.starts_with('-') {
            if t == "-o" || t == "--output" {
                return Err("invalid");
            }
            continue;
        }
        if local_health_url(t) {
            saw_url = true;
        } else if t.contains("://") {
            return Err("invalid");
        }
    }
    if saw_url { Ok(()) } else { Err("invalid") }
}

fn local_health_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://localhost")
        || lower.starts_with("http://[::1]")
        || lower.starts_with("https://127.0.0.1")
        || lower.starts_with("https://localhost")
        || lower.starts_with("https://[::1]")
}

pub fn is_diagnosis(execution_mode: Option<&str>) -> bool {
    execution_mode == Some("diagnosis")
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "systemctl status nginx",
            "curl -fsS http://127.0.0.1/health",
            "curl http://localhost:8080/ready",
        ] {
            assert_eq!(bash_allowed(cmd), Ok(()), "expected allow: {cmd}");
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
            assert_ne!(bash_allowed(cmd), Ok(()), "expected block: {cmd}");
        }
    }

    #[test]
    fn du_depth_is_capped() {
        assert_eq!(bash_allowed("du -d 6 /var"), Err("invalid"));
        assert_eq!(bash_allowed("du --max-depth=9 /var"), Err("invalid"));
    }
}
