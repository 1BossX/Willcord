//! `willcord trust-ca`: put a main node's root certificate in this machine's system
//! trust store. The certificate comes from the one unverified request in
//! `cli::fetch_published_ca`; it must match a fingerprint the person got out of band,
//! and pass the main node's HTTPS check, before anything is imported.
use crate::{
    Error,
    cli::{
        ca_fingerprint, certificate_pem, check_main_node, fetch_published_ca, parse_join_link,
        private_dir, root, save, shell_quote, take_value, valid_fingerprint,
    },
    main_node::is_macos,
};
use std::{
    fs,
    io::{IsTerminal, Write},
    path::{Path, PathBuf},
    process::Command,
};

const USAGE: &str = "usage: willcord trust-ca LINK [--ca-fingerprint SHA256]";

#[derive(Debug, Clone, Copy, PartialEq)]
enum Platform {
    MacOs,
    Debian,
    Other,
}

/// Debian, Ubuntu and their derivatives have `update-ca-certificates`; macOS has the
/// keychain tool. Everything else gets its steps printed instead.
fn platform_from(macos: bool, os_release: &str) -> Platform {
    if macos {
        return Platform::MacOs;
    }
    let debian = os_release
        .lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(key, _)| *key == "ID" || *key == "ID_LIKE")
        .flat_map(|(_, value)| value.trim_matches('"').split_whitespace())
        .any(|id| id == "debian" || id == "ubuntu");
    if debian {
        Platform::Debian
    } else {
        Platform::Other
    }
}

fn current_platform() -> Platform {
    let os_release = fs::read_to_string(os_release_path()).unwrap_or_default();
    platform_from(is_macos(), &os_release)
}

fn os_release_path() -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("WILLCORD_TEST_OS_RELEASE") {
        return PathBuf::from(path);
    }
    PathBuf::from("/etc/os-release")
}

/// The trust-store file name for a root: derived from the fingerprint, so a repeat
/// run replaces the same file and several main nodes can be trusted side by side.
fn anchor_name(fingerprint: &str) -> String {
    format!("willcord-ca-{}.crt", &fingerprint[..16])
}

/// Either commands to run, each a program and its arguments (run through sudo when
/// not root), or the steps to follow by hand where there is no command to run.
#[derive(Debug, PartialEq)]
enum Import {
    Run(Vec<Vec<String>>),
    Manual(Vec<String>),
}

fn import_plan(platform: Platform, pem: &Path, fingerprint: &str) -> Import {
    let pem = pem.display().to_string();
    let anchor = anchor_name(fingerprint);
    match platform {
        Platform::MacOs => Import::Run(vec![words(&[
            "security",
            "add-trusted-cert",
            "-d",
            "-r",
            "trustRoot",
            "-k",
            "/Library/Keychains/System.keychain",
            pem.as_str(),
        ])]),
        Platform::Debian => {
            let dest = format!("/usr/local/share/ca-certificates/{anchor}");
            Import::Run(vec![
                words(&["install", "-m", "0644", pem.as_str(), dest.as_str()]),
                words(&["update-ca-certificates"]),
            ])
        }
        Platform::Other => {
            let quoted = shell_quote(Path::new(&pem));
            Import::Manual(vec![
                format!(
                    "  Fedora / RHEL：sudo cp {quoted} /etc/pki/ca-trust/source/anchors/{anchor} && sudo update-ca-trust"
                ),
                format!("  Arch：sudo trust anchor --store {quoted}"),
                "  其他系统：把该文件加入系统信任库，参见发行版文档。".to_owned(),
            ])
        }
    }
}

fn words(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| (*part).to_owned()).collect()
}

fn run_import(steps: &[Vec<String>]) -> Result<(), Error> {
    let elevated = unsafe { libc::geteuid() } != 0;
    for step in steps {
        let (program, args) = if elevated {
            ("sudo", step.as_slice())
        } else {
            (step[0].as_str(), &step[1..])
        };
        let status = Command::new(program)
            .args(args)
            .status()
            .map_err(|e| format!("无法运行 {program}：{e}"))?;
        if !status.success() {
            return Err(format!(
                "导入失败：{}（退出码 {}），未完成导入。",
                step.join(" "),
                status.code().map_or("未知".to_owned(), |c| c.to_string())
            )
            .into());
        }
    }
    Ok(())
}

/// Whether what the person typed is the fingerprint, ignoring case, spaces and the
/// colons OpenSSL puts between bytes.
fn same_fingerprint(answer: &str, fingerprint: &str) -> bool {
    let normalized: String = answer
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect::<String>()
        .to_ascii_lowercase();
    normalized == fingerprint
}

/// The fingerprint printed here came from the same unverified request as the
/// certificate, so it proves nothing until the administrator's copy is typed in.
fn confirm_fingerprint(fingerprint: &str) -> Result<(), Error> {
    print!("请输入管理员渠道提供的指纹以确认导入（直接回车取消）：");
    std::io::stdout().flush()?;
    let mut answer = String::new();
    std::io::stdin().read_line(&mut answer)?;
    if answer.trim().is_empty() {
        return Err("已取消，未导入任何内容。".into());
    }
    if same_fingerprint(&answer, fingerprint) {
        Ok(())
    } else {
        Err("输入的指纹与主节点提供的不一致，未导入任何内容。".into())
    }
}

pub async fn trust_ca(mut args: Vec<String>) -> Result<(), Error> {
    let flag = take_value(&mut args, "--ca-fingerprint")?;
    let [link] = args.as_slice() else {
        return Err(USAGE.into());
    };
    let (origin, from_link) = parse_join_link(link)?;
    let expected = match (flag, from_link) {
        (Some(_), Some(_)) => {
            return Err("加入链接已含 CA 指纹，不能再与 --ca-fingerprint 同用。".into());
        }
        (Some(flag), None) => Some(valid_fingerprint(&flag)?),
        (None, link) => link,
    };
    if expected.is_none() && !std::io::stdin().is_terminal() {
        return Err("没有 CA 指纹时需要在终端确认。请在加入链接的 # 后或用 --ca-fingerprint 给出管理员渠道提供的指纹。".into());
    }

    let pem = certificate_pem(&fetch_published_ca(&origin).await?)?;
    let fingerprint = ca_fingerprint(pem.as_bytes())?;
    match &expected {
        Some(wanted) if *wanted != fingerprint => {
            return Err(
                format!("CA 指纹不匹配：主节点提供的是 {fingerprint}，未导入任何内容。").into(),
            );
        }
        Some(_) => println!("CA 指纹已核对：{fingerprint}"),
        None => {
            println!("主节点根证书的 CA 指纹（SHA-256）：{fingerprint}");
            println!("请与管理员渠道（控制台“信任证书”页或管理员）提供的指纹核对。");
            confirm_fingerprint(&fingerprint)?;
        }
    }

    let dir = root()?.join("trusted-ca");
    private_dir(&dir)?;
    let path = dir.join(format!("{fingerprint}.pem"));
    save(&path, pem.as_bytes())?;
    if let Err(e) = check_main_node(&origin, Some(&path)).await {
        let _ = fs::remove_file(&path);
        return Err(e);
    }
    println!("HTTPS 校验通过：{origin}");

    match import_plan(current_platform(), &path, &fingerprint) {
        Import::Run(steps) => {
            run_import(&steps)?;
            println!("根证书已导入系统信任库。");
        }
        Import::Manual(lines) => {
            println!(
                "本机没有可自动执行的导入命令，请手动把根证书加入系统信任库：{}",
                path.display()
            );
            for line in lines {
                println!("{line}");
            }
        }
    }
    println!(
        "Firefox 使用自己的证书库，需要单独导入：设置 → 隐私与安全 → 证书 → 查看证书 → 证书颁发机构 → 导入，选择 {}，并勾选“信任此 CA 以标识网站”。",
        path.display()
    );
    println!(
        "导入后重启浏览器。执行机器运行 willcord worker join 时会自动获取并核对同一根证书，无需单独信任。"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn the_platform_comes_from_the_os_and_its_family() {
        assert_eq!(platform_from(true, "ID=ubuntu"), Platform::MacOs);
        assert_eq!(
            platform_from(false, "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\n"),
            Platform::Debian
        );
        assert_eq!(
            platform_from(false, "ID=linuxmint\nID_LIKE=\"ubuntu debian\"\n"),
            Platform::Debian
        );
        assert_eq!(
            platform_from(false, "ID=fedora\nID_LIKE=\"rhel fedora\"\n"),
            Platform::Other
        );
        assert_eq!(platform_from(false, ""), Platform::Other);
    }

    #[test]
    fn debian_installs_one_named_anchor_then_updates_the_store() {
        let plan = import_plan(Platform::Debian, Path::new("/d/x.pem"), FP);
        assert_eq!(
            plan,
            Import::Run(vec![
                words(&[
                    "install",
                    "-m",
                    "0644",
                    "/d/x.pem",
                    "/usr/local/share/ca-certificates/willcord-ca-0123456789abcdef.crt"
                ]),
                words(&["update-ca-certificates"]),
            ])
        );
    }

    #[test]
    fn macos_adds_the_root_as_trusted_in_the_system_keychain() {
        assert_eq!(
            import_plan(Platform::MacOs, Path::new("/d/x.pem"), FP),
            Import::Run(vec![words(&[
                "security",
                "add-trusted-cert",
                "-d",
                "-r",
                "trustRoot",
                "-k",
                "/Library/Keychains/System.keychain",
                "/d/x.pem",
            ])])
        );
    }

    #[test]
    fn other_systems_get_quoted_steps_and_no_command() {
        let Import::Manual(lines) = import_plan(Platform::Other, Path::new("/d/o'ne.pem"), FP)
        else {
            panic!("expected manual steps");
        };
        let text = lines.join("\n");
        assert!(text.contains("sudo update-ca-trust"));
        assert!(text.contains("trust anchor --store '/d/o'\\''ne.pem'"));
        assert!(text.contains("willcord-ca-0123456789abcdef.crt"));
    }

    #[test]
    fn a_repeat_run_targets_the_same_store_file_and_another_root_a_new_one() {
        let other = FP.replacen('0', "f", 1);
        assert_eq!(anchor_name(FP), anchor_name(FP));
        assert_ne!(anchor_name(FP), anchor_name(&other));
    }

    #[test]
    fn the_typed_fingerprint_may_come_in_any_case_or_with_colons() {
        assert!(same_fingerprint(&format!("{FP}\n"), FP));
        assert!(same_fingerprint(&FP.to_uppercase(), FP));
        let colons: String = FP
            .as_bytes()
            .chunks(2)
            .map(|pair| std::str::from_utf8(pair).unwrap())
            .collect::<Vec<_>>()
            .join(":");
        assert!(same_fingerprint(&colons, FP));
        assert!(!same_fingerprint(&FP[1..], FP));
        assert!(!same_fingerprint("", FP));
    }
}
