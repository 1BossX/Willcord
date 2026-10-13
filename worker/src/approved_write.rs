// O2-KR2 post-approval write allowlist. Enforced on the worker before exec.
// Read-side diagnosis policy stays in diagnosis.rs (O2-KR1).

fn reject_token_metacharacters(token: &str) -> Result<(), &'static str> {
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

pub fn is_approved(execution_mode: Option<&str>) -> bool {
    execution_mode == Some("approved")
}

/// Writes stay blocked in approved mode; fixes use the bash allowlist below.
pub fn write_allowed(execution_mode: Option<&str>) -> bool {
    !is_approved(execution_mode)
}

/// Bash allowed only for operator-approved remediation shapes (restart stuck process/container).
pub fn bash_allowed(command: &str) -> Result<(), &'static str> {
    bash_argv(command).map(|_| ())
}

pub fn bash_argv(command: &str) -> Result<Vec<String>, &'static str> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("invalid");
    }
    let tokens: Vec<String> = trimmed.split_whitespace().map(|s| s.to_owned()).collect();
    if tokens.is_empty() {
        return Err("invalid");
    }
    for token in &tokens {
        reject_token_metacharacters(token)?;
    }
    match tokens[0].as_str() {
        "docker" => allow_docker_restart(&tokens),
        "systemctl" => allow_systemctl_restart(&tokens),
        "kill" => allow_kill(&tokens),
        _ => Err("invalid"),
    }
}

fn allow_docker_restart(tokens: &[String]) -> Result<Vec<String>, &'static str> {
    match tokens.len() {
        3 if tokens[1] == "restart" && !tokens[2].starts_with('-') => Ok(tokens.to_vec()),
        _ => Err("invalid"),
    }
}

fn allow_systemctl_restart(tokens: &[String]) -> Result<Vec<String>, &'static str> {
    match tokens.len() {
        3 if tokens[1] == "restart" && !tokens[2].is_empty() && !tokens[2].starts_with('-') => {
            Ok(tokens.to_vec())
        }
        _ => Err("invalid"),
    }
}

fn allow_kill(tokens: &[String]) -> Result<Vec<String>, &'static str> {
    match tokens.len() {
        2 => {
            if tokens[1].chars().all(|c| c.is_ascii_digit()) {
                Ok(tokens.to_vec())
            } else {
                Err("invalid")
            }
        }
        3 if tokens[1] == "-TERM" || tokens[1] == "-HUP" || tokens[1] == "-INT" => {
            if tokens[2].chars().all(|c| c.is_ascii_digit()) {
                Ok(tokens.to_vec())
            } else {
                Err("invalid")
            }
        }
        _ => Err("invalid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approved_mode_blocks_writes() {
        assert!(!write_allowed(Some("approved")));
        assert!(write_allowed(None));
    }

    #[test]
    fn post_approval_restart_shapes() {
        for cmd in [
            "docker restart web",
            "systemctl restart nginx.service",
            "kill 4242",
            "kill -TERM 99",
        ] {
            assert_eq!(bash_allowed(cmd), Ok(()), "expected allow: {cmd}");
        }
    }

    #[test]
    fn non_allowlisted_commands_stay_blocked() {
        for cmd in [
            "docker ps",
            "docker rm web",
            "systemctl status nginx",
            "rm -rf /tmp/x",
            "docker restart web; touch /tmp/x",
            "kill $(pidof x)",
        ] {
            assert_ne!(bash_allowed(cmd), Ok(()), "expected block: {cmd}");
        }
    }
}
