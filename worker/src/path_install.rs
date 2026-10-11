//! `willcord self-install` / `self-uninstall`: keep one copy of the CLI where a
//! shell finds it (`~/.local/bin`, or `/usr/local/bin` for a system install).
//!
//! The copy is separate from the one a service runs inside its data directory,
//! so replacing or removing it never touches a running service. Shell startup
//! files are never edited: when the directory is not on `PATH` the person is
//! told what to add. A same-named file this program did not install is left alone.
use crate::Error;
use std::{
    ffi::OsStr,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// Present in every willcord binary, which is how a file at the install path is
/// recognised as ours. Bump the suffix if the scheme ever has to change.
static MARKER: [u8; 32] = *b"willcord-cli-install-marker-v1\0\0";
const NAME: &str = "willcord";

fn marker() -> &'static [u8] {
    // Reached from live code, so the linker keeps it even in a stripped release build.
    std::hint::black_box(&MARKER)
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Scope {
    User,
    System,
}

#[derive(Debug, PartialEq)]
pub enum Installed {
    /// Nothing was there.
    New,
    /// An earlier copy of ours was replaced.
    Replaced,
    /// The running binary already is the installed one.
    Current,
    /// Something else is at the path; it was not touched.
    Foreign,
}

#[derive(Debug, PartialEq)]
pub enum Removed {
    Removed,
    Absent,
    Foreign,
}

pub fn bin_dir(scope: Scope) -> Result<PathBuf, Error> {
    match scope {
        Scope::System => Ok(PathBuf::from("/usr/local/bin")),
        Scope::User => {
            let home = std::env::var_os("HOME").ok_or("HOME required")?;
            let home = PathBuf::from(home);
            if !home.is_absolute() {
                return Err("HOME must be an absolute path".into());
            }
            Ok(home.join(".local/bin"))
        }
    }
}

/// Is `dir` one of the entries of a `PATH` value? Empty entries (the current
/// directory) and relative ones never count.
pub fn on_path(dir: &Path, path_var: Option<&OsStr>) -> bool {
    path_var
        .is_some_and(|p| std::env::split_paths(p).any(|entry| entry.is_absolute() && entry == dir))
}

/// A regular file (not a link) carrying our marker.
pub fn is_ours(path: &Path) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    let needle = marker();
    fs::read(path).is_ok_and(|bytes| bytes.windows(needle.len()).any(|w| w == needle))
}

/// Copy `source` to `dir/willcord` atomically with mode 0755.
pub fn install_to(source: &Path, dir: &Path) -> Result<(PathBuf, Installed), Error> {
    let target = dir.join(NAME);
    let outcome = match fs::symlink_metadata(&target) {
        Err(_) => Installed::New,
        // A link is somebody's arrangement, even when it leads to one of our binaries.
        Ok(meta) if meta.file_type().is_symlink() => return Ok((target, Installed::Foreign)),
        Ok(_) if fs::canonicalize(&target).ok() == fs::canonicalize(source).ok() => {
            return Ok((target, Installed::Current));
        }
        Ok(_) if is_ours(&target) => {
            // The same build again (a re-run of the installer) changes nothing.
            if fs::read(&target)? == fs::read(source)? {
                return Ok((target, Installed::Current));
            }
            Installed::Replaced
        }
        Ok(_) => return Ok((target, Installed::Foreign)),
    };
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(".{NAME}.tmp-{}", uuid::Uuid::new_v4()));
    let write = || -> Result<(), Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)?;
        file.write_all(&fs::read(source)?)?;
        file.sync_all()?;
        // The umask may have narrowed the mode the file was created with.
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))?;
        fs::rename(&tmp, &target)?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok((target, outcome))
}

pub fn uninstall_from(dir: &Path) -> Result<(PathBuf, Removed), Error> {
    let target = dir.join(NAME);
    let outcome = if fs::symlink_metadata(&target).is_err() {
        Removed::Absent
    } else if is_ours(&target) {
        fs::remove_file(&target)?;
        Removed::Removed
    } else {
        Removed::Foreign
    };
    Ok((target, outcome))
}

/// `$HOME/.local/bin` as a person would type it in a shell.
fn shell_form(dir: &Path) -> String {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    match home.as_deref().and_then(|h| dir.strip_prefix(h).ok()) {
        Some(rest) => format!("$HOME/{}", rest.display()),
        None => dir.display().to_string(),
    }
}

/// What the person is told after an install. `on_path` is whether `dir` is on `PATH`.
pub fn report(outcome: &Installed, dir: &Path, on_path: bool) -> String {
    let target = dir.join(NAME);
    let mut text = match outcome {
        Installed::New => format!("已安装命令：{}", target.display()),
        Installed::Replaced => format!("已更新命令：{}", target.display()),
        Installed::Current => format!("命令已就位：{}", target.display()),
        Installed::Foreign => {
            return format!(
                "{} 已存在，不是 willcord 安装的，没有覆盖。willcord 的服务不受影响；\
                 想用 willcord 命令请先移走该文件，再运行 willcord self-install。",
                target.display()
            );
        }
    };
    if !on_path {
        text.push_str(&format!(
            "\n{} 不在 PATH 中。在当前终端运行：\n  export PATH=\"{}:$PATH\"\n要永久生效，把这一行加进 ~/.zshrc 或 ~/.bashrc（willcord 不会改这些文件）。",
            dir.display(),
            shell_form(dir)
        ));
    }
    text
}

pub fn report_removed(outcome: &Removed, dir: &Path) -> String {
    let target = dir.join(NAME);
    match outcome {
        Removed::Removed => format!("已移除命令：{}", target.display()),
        Removed::Absent => format!("{} 不存在，无需移除。", target.display()),
        Removed::Foreign => format!("{} 不是 willcord 安装的，没有移除。", target.display()),
    }
}

/// Install the running binary for `scope`, returning what to tell the person.
/// A system install writes into a root-owned directory, so it needs sudo.
pub fn install_running(scope: Scope) -> Result<(Installed, String), Error> {
    if scope == Scope::System && unsafe { libc::geteuid() } != 0 {
        return Err("self-install --system must run as root (sudo)".into());
    }
    let dir = bin_dir(scope)?;
    let (_, outcome) = install_to(&std::env::current_exe()?, &dir)?;
    let text = report(
        &outcome,
        &dir,
        on_path(&dir, std::env::var_os("PATH").as_deref()),
    );
    Ok((outcome, text))
}

pub fn uninstall_running(scope: Scope) -> Result<(Removed, String), Error> {
    if scope == Scope::System && unsafe { libc::geteuid() } != 0 {
        return Err("self-uninstall --system must run as root (sudo)".into());
    }
    let dir = bin_dir(scope)?;
    let (_, outcome) = uninstall_from(&dir)?;
    let text = report_removed(&outcome, &dir);
    Ok((outcome, text))
}

/// How a later hint should name the command: plain `willcord` when the copy on
/// `PATH` is ours, else the quoted `fallback` path.
pub fn command_for(scope: Scope, fallback: &Path) -> String {
    match bin_dir(scope) {
        Ok(dir) if is_ours(&dir.join(NAME)) => NAME.to_owned(),
        _ => crate::cli::shell_quote(fallback),
    }
}

/// Install the running binary as a side effect of another command, never failing it.
/// Prints what happened and returns the command later hints should use: plain
/// `willcord` when it is in place, else the quoted `fallback` path.
pub fn ensure(scope: Scope, fallback: &Path) -> String {
    match install_running(scope) {
        Ok((Installed::Foreign, text)) => {
            eprintln!("{text}");
            crate::cli::shell_quote(fallback)
        }
        Ok((_, text)) => {
            println!("{text}");
            NAME.to_owned()
        }
        Err(e) => {
            eprintln!(
                "提示：没能把 willcord 命令装到 PATH（{e}）；之后可运行 willcord self-install 重试。"
            );
            crate::cli::shell_quote(fallback)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("wc-path-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }
    /// A stand-in for a willcord binary: anything carrying the marker.
    fn ours(path: &Path, extra: &str) {
        let mut bytes = marker().to_vec();
        bytes.extend_from_slice(extra.as_bytes());
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn the_running_binary_carries_the_marker() {
        // If this fails, a release build could install a copy it cannot later recognise.
        assert!(is_ours(&std::env::current_exe().unwrap()));
    }

    #[test]
    fn user_and_system_places_are_fixed() {
        assert_eq!(
            bin_dir(Scope::System).unwrap(),
            PathBuf::from("/usr/local/bin")
        );
        let home = std::env::var("HOME").unwrap();
        assert_eq!(
            bin_dir(Scope::User).unwrap(),
            PathBuf::from(home).join(".local/bin")
        );
    }

    #[test]
    fn path_membership_ignores_empty_and_relative_entries() {
        let p = OsStr::new("/usr/bin::/home/a/.local/bin:bin:/opt/x");
        assert!(on_path(Path::new("/home/a/.local/bin"), Some(p)));
        assert!(on_path(Path::new("/usr/bin"), Some(p)));
        assert!(!on_path(Path::new("/home/a/.local"), Some(p)));
        assert!(!on_path(Path::new("bin"), Some(p)));
        assert!(!on_path(Path::new("/usr/bin"), None));
        assert!(!on_path(Path::new("/usr/bin"), Some(OsStr::new(""))));
    }

    #[test]
    fn a_fresh_install_creates_the_directory_and_an_executable_copy() {
        let root = temp();
        let source = root.join("download");
        ours(&source, "v1");
        let dir = root.join("home/.local/bin");
        let (target, outcome) = install_to(&source, &dir).unwrap();
        assert_eq!(outcome, Installed::New);
        assert_eq!(target, dir.join("willcord"));
        assert_eq!(fs::read(&target).unwrap(), fs::read(&source).unwrap());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        // No temporary file is left behind.
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reinstalling_replaces_our_own_copy_and_nothing_else() {
        let root = temp();
        let dir = root.join("bin");
        fs::create_dir_all(&dir).unwrap();
        let (old, new) = (root.join("old"), root.join("new"));
        ours(&old, "v1");
        ours(&new, "v2");
        install_to(&old, &dir).unwrap();
        let (target, outcome) = install_to(&new, &dir).unwrap();
        assert_eq!(outcome, Installed::Replaced);
        assert_eq!(fs::read(&target).unwrap(), fs::read(&new).unwrap());
        // Installing from the installed copy itself, or the same build again, is a no-op.
        assert_eq!(install_to(&target, &dir).unwrap().1, Installed::Current);
        let same = root.join("same");
        fs::copy(&new, &same).unwrap();
        assert_eq!(install_to(&same, &dir).unwrap().1, Installed::Current);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_file_we_did_not_install_is_never_overwritten_or_removed() {
        let root = temp();
        let dir = root.join("bin");
        fs::create_dir_all(&dir).unwrap();
        let source = root.join("download");
        ours(&source, "v1");
        let target = dir.join("willcord");
        fs::write(&target, b"#!/bin/sh\necho someone else's tool\n").unwrap();
        assert_eq!(install_to(&source, &dir).unwrap().1, Installed::Foreign);
        assert_eq!(
            fs::read(&target).unwrap(),
            b"#!/bin/sh\necho someone else's tool\n"
        );
        assert_eq!(uninstall_from(&dir).unwrap().1, Removed::Foreign);
        assert!(target.exists());
        // A symlink is foreign even when it points at one of ours.
        fs::remove_file(&target).unwrap();
        std::os::unix::fs::symlink(&source, &target).unwrap();
        assert_eq!(install_to(&source, &dir).unwrap().1, Installed::Foreign);
        assert_eq!(uninstall_from(&dir).unwrap().1, Removed::Foreign);
        assert!(fs::symlink_metadata(&target).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn uninstall_removes_only_our_copy() {
        let root = temp();
        let dir = root.join("bin");
        assert_eq!(uninstall_from(&dir).unwrap().1, Removed::Absent);
        let source = root.join("download");
        ours(&source, "v1");
        install_to(&source, &dir).unwrap();
        assert_eq!(uninstall_from(&dir).unwrap().1, Removed::Removed);
        assert!(!dir.join("willcord").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_message_names_the_path_fix_without_editing_anything() {
        let dir = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap()
            .join(".local/bin");
        let off = report(&Installed::New, &dir, false);
        assert!(
            off.contains("export PATH=\"$HOME/.local/bin:$PATH\""),
            "{off}"
        );
        assert!(off.contains("willcord 不会改这些文件"));
        let on = report(&Installed::New, &dir, true);
        assert!(!on.contains("export PATH"));
        let foreign = report(&Installed::Foreign, &dir, false);
        assert!(foreign.contains("没有覆盖") && !foreign.contains("export PATH"));
        assert!(report(&Installed::Replaced, Path::new("/usr/local/bin"), true).contains("已更新"));
    }
}
