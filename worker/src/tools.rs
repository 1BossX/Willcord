// Remote tool implementations. Paths resolve through directory handles so a
// workspace can never be escaped through `..` or symbolic links.
use crate::generated::{ToolCall, Workspace};
use serde_json::Value;
use sha2::Digest;
use std::{fs, path::PathBuf, time::Duration};
use uuid::Uuid;

type Error = Box<dyn std::error::Error + Send + Sync>;

pub async fn execute_tool(workspaces: &[Workspace], call: &ToolCall) -> Result<Value, Error> {
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
) -> Result<(std::os::fd::OwnedFd, std::ffi::CString), Error> {
    use std::os::{
        fd::{FromRawFd, OwnedFd},
        unix::ffi::OsStrExt,
    };
    use std::path::Component;
    let parts: Vec<std::ffi::CString> = std::path::Path::new(relative)
        .components()
        .map(|c| -> Result<std::ffi::CString, Error> {
            match c {
                Component::Normal(v) => Ok(std::ffi::CString::new(v.as_bytes())?),
                _ => Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "path traversal",
                ))),
            }
        })
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
fn read_workspace_file(root: &str, relative: &str) -> Result<Vec<u8>, Error> {
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
) -> Result<(), Error> {
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
    let write_result = (|| -> Result<(), Error> {
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
