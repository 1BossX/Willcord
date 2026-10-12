#!/usr/bin/env bash
# Public entry point: the entire script defines functions before invoking main.
# `install.sh` alone installs the willcord command; `install.sh main|worker …`
# installs it and starts that role in one step.
# Requires Bash 3.2+, curl and a SHA-256 utility; no jq or Python dependency.
set -euo pipefail

fail() { printf '安装失败：%s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少 $1，请安装后重试。"; }
fetch() { curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 "$1" -o "$2" || fail "下载失败：$1"; }
sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1";
  else sha256sum "$1"; fi
}
verified() {
  local name="$1" expected actual
  fetch "$release/$name" "$tmp/$name"
  fetch "$release/$name.sha256" "$tmp/$name.sha256"
  read -r expected _ < "$tmp/$name.sha256"
  [[ "$expected" =~ ^[a-fA-F0-9]{64}$ ]] || fail "校验文件无效：$name"
  actual=$(sha256 "$tmp/$name"); actual=${actual%% *}
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  [[ "$expected" == "$actual" ]] || fail "SHA-256 不匹配：${name}，未执行安装。"
}
origin() {
  [[ "$1" =~ ^https://([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]+\])(:([0-9]+))?/?$ ]] || fail "地址必须是 HTTPS origin（主机及可选端口，不含路径、用户信息或查询参数）。"
  local host=${BASH_REMATCH[1]}
  port=${BASH_REMATCH[3]:-443}
  [[ ${#port} -le 5 ]] && (( 10#$port >= 1 && 10#$port <= 65535 )) || fail "端口必须在 1–65535 之间。"
  port=$((10#$port))
  host=$(printf '%s' "$host" | tr 'A-Z' 'a-z')
  site="$host:$port"; server="https://$host"
  [[ "$port" == 443 ]] || server="$server:$port"
}
resolve_version() {
  local resolved stable=true explicit=true
  if [[ -z "$version" ]]; then
    explicit=false
    # With no Release, GitHub redirects /releases/latest to /releases.
    resolved=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/BossOptional/Willcord/releases/latest") || resolved=''
    [[ "$resolved" == */releases/tag/* ]] || fail "没有可访问的正式 Release。请等待发布，或用 --version 指定已发布版本。"
    version=${resolved##*/}
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "最新 Release 不是正式版本 vX.Y.Z：${version}。"
  fi
  # Pre-releases (vX.Y.Z-rc.N) are installed only when named with --version.
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "版本必须是 vX.Y.Z，或显式指定的预发布版本 vX.Y.Z-rc.N。"
  [[ "$version" != *-* ]] || stable=false
  # /releases/latest only ever names a published, formal Release, so the GitHub
  # API is consulted for an explicit --version alone. Anonymous API requests are
  # limited to 60 per hour per IP and shared NATs and proxies exhaust that, so
  # the check is best effort: when the API is unavailable the install goes on,
  # and a draft's assets cannot be downloaded without authentication anyway.
  if [[ "$explicit" == true ]]; then
    if curl --fail --silent --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 "https://api.github.com/repos/BossOptional/Willcord/releases/tags/$version" -o "$tmp/release.json" 2>/dev/null; then
      grep -Eq '"draft":[[:space:]]*false' "$tmp/release.json" || fail "版本尚未发布。"
      if [[ "$stable" == true ]]; then
        grep -Eq '"prerelease":[[:space:]]*false' "$tmp/release.json" || fail "${version} 标记为预发布，不是正式版本。"
      fi
    else
      printf 'GitHub API 暂不可用（可能被限流），跳过 %s 的发布状态检查；仍会校验下载文件的 SHA-256。\n' "$version" >&2
    fi
  fi
  if [[ "$stable" == true ]]; then
    printf '安装版本：%s\n' "$version"
  else
    printf '安装预发布版本：%s（仅用于验收）\n' "$version"
  fi
  release="https://github.com/BossOptional/Willcord/releases/download/$version"
}
# The binary does the rest: `willcord worker join` installs the service, saves
# the CA (--ca, or fetched and checked against --ca-fingerprint), puts the
# `willcord` command on PATH and files the join request. This script only
# validates what it can before asking for sudo, and hands over the verified binary.
# The checks below mirror the binary's (parse_join_link and valid_user in
# worker/src/cli.rs), which are the authority; keep them in step.
worker_install() {
  [[ -n "$server" ]] || fail "worker 需要加入链接，例如 worker 'https://主节点地址#sha256=<CA 指纹>'。"
  # The join link is the origin, optionally followed by #sha256=<CA fingerprint>.
  if [[ "$server" == *'#'* ]]; then
    [[ "${server#*#}" =~ ^sha256=([a-fA-F0-9]{64})$ ]] || fail "加入链接的 # 后只能是 sha256=<64 位十六进制 CA 指纹>。"
    [[ -z "$ca" && -z "$fingerprint" ]] || fail "加入链接已含 CA 指纹，不能再与 --ca、--ca-fingerprint 同用。"
    fingerprint=${BASH_REMATCH[1]}
    server=${server%%#*}
  fi
  origin "$server"
  [[ -z "$ca" || -z "$fingerprint" ]] || fail "--ca 与 --ca-fingerprint 不能同时使用。"
  if [[ -n "$ca" ]]; then
    [[ "$ca" == /* && -r "$ca" && -f "$ca" ]] || fail "CA 必须是可读的绝对文件路径。"
  fi
  [[ -z "$fingerprint" ]] || [[ "$fingerprint" =~ ^[a-fA-F0-9]{64}$ ]] || fail "CA 指纹必须是证书 DER 的 64 位 SHA-256。"
  if [[ "$system" == true ]]; then
    # Without --user the service runs as whoever is installing it (the sudo caller when root).
    if [[ -z "$account" ]]; then
      if [[ $(id -u) == 0 ]]; then account=${SUDO_USER:-}; else account=$(id -un); fi
    fi
    [[ "$account" =~ ^[A-Za-z0-9._-]+$ && "$account" != -* && ${#account} -le 64 ]] || fail "--system 需要 --user 指定已有普通账户（用 sudo 运行时默认取执行 sudo 的账户）。"
    local uid; uid=$(id -u "$account") || fail "账户不存在：$account"
    [[ "$uid" != 0 ]] || fail "执行账户不能是 root。"
    if [[ $(id -u) != 0 ]]; then need sudo; fi
  else
    [[ -z "$account" ]] || fail "--user 只能与 --system 一起使用。"
    [[ $(id -u) != 0 ]] || fail "用户级安装请不要使用 sudo；服务器请加 --system。"
  fi
  if [[ "$os" == linux ]]; then need systemctl; else need launchctl; fi
  local name="willcord-$version-$os-$arch"
  verified "$name"
  chmod 700 "$tmp/$name"
  local args=(worker join "$server")
  [[ -z "$ca" ]] || args+=(--ca "$ca")
  [[ -z "$fingerprint" ]] || args+=(--ca-fingerprint "$fingerprint")
  if [[ "$system" == true ]]; then
    args+=(--system --user "$account")
    if [[ $(id -u) == 0 ]]; then
      "$tmp/$name" "${args[@]}"
    else
      # sudo drops the environment; keep the one override a test or a custom root sets.
      local keep=()
      [[ -z "${WILLCORD_SYSTEM_ROOT:-}" ]] || keep=("WILLCORD_SYSTEM_ROOT=$WILLCORD_SYSTEM_ROOT")
      sudo env ${keep[@]+"${keep[@]}"} "$tmp/$name" "${args[@]}"
    fi
  else
    "$tmp/$name" "${args[@]}"
  fi
}
# The setup wizard is `willcord main init`: this script only fetches a verified
# binary and hands over. The wizard reads /dev/tty itself, so it also works when
# the script arrives through `curl | bash`.
main_install() {
  [[ "$system" == false && -z "$account" && -z "$ca" && -z "$fingerprint" ]] || fail "main 不接受 --system、--user 或 CA 参数。"
  local name="willcord-$version-$os-$arch"
  verified "$name"
  chmod 700 "$tmp/$name"
  local args=(main init --dir "$directory" --image-version "$version")
  [[ -z "$server" ]] || args+=(--server "$server")
  "$tmp/$name" "${args[@]}"
}
# Without a role the script only installs: the verified binary puts the
# `willcord` command on PATH and nothing is started. `willcord main init` and
# `willcord worker join` are then run by hand.
install_only() {
  [[ -z "$server" && -z "$ca" && -z "$fingerprint" && -z "$account" ]] || fail "只安装命令时不接受 --server、--ca、--ca-fingerprint 或 --user；安装后用 willcord main init / willcord worker join 启动。"
  if [[ "$system" == true ]]; then
    if [[ $(id -u) != 0 ]]; then need sudo; fi
  else
    [[ $(id -u) != 0 ]] || fail "用户级安装请不要使用 sudo；系统级安装请加 --system。"
  fi
  local name="willcord-$version-$os-$arch"
  verified "$name"
  chmod 700 "$tmp/$name"
  local args=(self-install)
  [[ "$system" == false ]] || args+=(--system)
  if [[ "$system" == true && $(id -u) != 0 ]]; then
    sudo "$tmp/$name" "${args[@]}"
  else
    "$tmp/$name" "${args[@]}"
  fi
  printf '\n下一步，按这台机器的角色启动：\n  主节点：willcord main init\n  执行机器：willcord worker join '"'"'https://<主节点地址>#sha256=<控制台提供的 CA 指纹>'"'"'\n'
}
main() {
  local usage='用法：install.sh [--version vX.Y.Z] [--system]（只安装 willcord 命令）；install.sh main [--version vX.Y.Z] [--server HTTPS_ORIGIN] [--dir PATH]；install.sh worker LINK [--version vX.Y.Z] [--ca /absolute/ca.pem | --ca-fingerprint SHA256] [--system [--user ACCOUNT]]（安装并立即启动；LINK 是 https://主机:端口，可在后面加 #sha256=<CA 指纹>）'
  local role="${1:-install}"
  case "$role" in
    worker|main) shift;;
    install|-*) role=install;;
    *) fail "$usage";;
  esac
  version=''; server=''; ca=''; fingerprint=''; system=false; account=''; directory="$PWD/willcord"
  while (( $# )); do
    case "$1" in
      --version|--server|--ca|--ca-fingerprint|--user|--dir)
        (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || fail "$1 缺少参数。"
        case "$1" in --version) version="$2";; --server) server="$2";; --ca) ca="$2";; --ca-fingerprint) fingerprint="$2";; --user) account="$2";; --dir) [[ "$role" == main ]] || fail '--dir 只用于 main。'; directory="$2";; esac
        shift 2;;
      --system) system=true; shift;;
      # worker takes its join link as the one bare argument; --server is the older spelling.
      -*) fail "未知参数：$1";;
      *) [[ "$role" == worker && -z "$server" ]] || fail "未知参数：$1"; server="$1"; shift;;
    esac
  done
  for tool in curl grep uname tr id mktemp cat mkdir cp chmod rm sed cut sleep; do need "$tool"; done
  command -v shasum >/dev/null 2>&1 || need sha256sum
  os=$(uname -s); arch=$(uname -m)
  case "$os" in Linux) os=linux;; Darwin) os=darwin;; *) fail "不支持的平台：$os";; esac
  case "$arch" in x86_64|amd64) arch=x86_64;; arm64|aarch64) if [[ "$os" == darwin ]]; then arch=arm64; else arch=aarch64; fi;; *) fail "不支持的架构：$arch";; esac
  umask 077
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/willcord-install.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  resolve_version
  case "$role" in worker) worker_install;; main) main_install;; *) install_only;; esac
}
main "$@"
