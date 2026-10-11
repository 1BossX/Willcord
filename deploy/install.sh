#!/usr/bin/env bash
# Public entry point: the entire script defines functions before invoking main.
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
# Single-quote shell arguments in the commands shown after installation.
quote() { local value="$1"; value=${value//\'/\'\\\'\'}; printf "'%s'" "$value"; }
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
    resolved=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/1BossX/Willcord/releases/latest") || resolved=''
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
    if curl --fail --silent --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 "https://api.github.com/repos/1BossX/Willcord/releases/tags/$version" -o "$tmp/release.json" 2>/dev/null; then
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
  release="https://github.com/1BossX/Willcord/releases/download/$version"
}
bootstrap_ca() {
  [[ "$fingerprint" =~ ^[a-fA-F0-9]{64}$ ]] || fail "CA 指纹必须是证书 DER 的 64 位 SHA-256。"
  need openssl; need head; need wc
  local actual size
  # Only this fixed, credential-free certificate request may skip verification.
  # No redirects; head caps streamed responses even on older curl versions.
  curl --disable --fail --silent --show-error --insecure --proto '=https' --connect-timeout 5 --max-time 15 "$server/.well-known/willcord/ca.pem" | head -c 65537 > "$tmp/bootstrap.pem" || fail "根证书获取失败。"
  size=$(wc -c < "$tmp/bootstrap.pem")
  (( size > 0 && size <= 65536 )) || fail "根证书响应过大或为空。"
  [[ $(grep -c '^-----BEGIN CERTIFICATE-----' "$tmp/bootstrap.pem") == 1 && $(grep -c '^-----END CERTIFICATE-----' "$tmp/bootstrap.pem") == 1 ]] || fail "必须提供单张根证书。"
  openssl x509 -in "$tmp/bootstrap.pem" -outform DER -out "$tmp/ca.der" || fail "根证书格式无效。"
  actual=$(sha256 "$tmp/ca.der"); actual=${actual%% *}
  fingerprint=$(printf '%s' "$fingerprint" | tr 'A-F' 'a-f')
  [[ "$actual" == "$fingerprint" ]] || fail "CA 指纹不匹配，未安装或申请加入。"
  openssl x509 -inform DER -in "$tmp/ca.der" -out "$tmp/ca.pem"
  ca="$tmp/ca.pem"
  printf 'CA 指纹已核对：%s\n' "$fingerprint"
}
worker_install() {
  [[ -n "$server" ]] || fail "worker 需要 --server HTTPS_ORIGIN。"
  origin "$server"
  [[ -z "$ca" || -z "$fingerprint" ]] || fail "--ca 与 --ca-fingerprint 不能同时使用。"
  if [[ -n "$ca" ]]; then
    [[ "$ca" == /* && -r "$ca" && -f "$ca" ]] || fail "CA 必须是可读的绝对文件路径。"
  fi
  if [[ "$system" == true ]]; then
    [[ "$account" =~ ^[A-Za-z0-9._-]+$ && "$account" != -* && ${#account} -le 64 ]] || fail "--system 需要 --user 指定已有普通账户。"
    local uid; uid=$(id -u "$account") || fail "账户不存在：$account"
    [[ "$uid" != 0 ]] || fail "执行账户不能是 root。"
    if [[ $(id -u) != 0 ]]; then need sudo; fi
  else
    [[ -z "$account" ]] || fail "--user 只能与 --system 一起使用。"
    [[ $(id -u) != 0 ]] || fail "用户级安装请不要使用 sudo；服务器请指定 --system --user。"
  fi
  if [[ "$os" == linux ]]; then
    need systemctl
    [[ "$system" == true ]] || systemctl --user show-environment >/dev/null || fail "需要 systemd 用户会话；常驻服务器请用 --system --user。"
  else
    need launchctl
    [[ "$system" == true ]] || launchctl print "gui/$(id -u)" >/dev/null || fail "macOS 用户级服务需要登录图形会话。"
  fi
  [[ -z "$fingerprint" ]] || bootstrap_ca
  local tls_args=()
  [[ -z "$ca" ]] || tls_args=(--cacert "$ca")
  curl --disable --fail --silent --show-error ${tls_args[@]+"${tls_args[@]}"} --connect-timeout 5 --max-time 15 "$server/health" -o "$tmp/worker-health.json" || fail "无法通过 CA 验证主节点 HTTPS，请检查证书、地址与网络。"
  local name="willcord-$version-$os-$arch" installed joined
  verified "$name"
  chmod 700 "$tmp/$name"
  if [[ "$system" == true ]]; then
    local system_root="${WILLCORD_SYSTEM_ROOT:-}"
    if [[ -z "$system_root" ]]; then
      if [[ "$os" == darwin ]]; then system_root='/Library/Application Support/Willcord'; else system_root=/var/lib/willcord-system; fi
    fi
    installed="$system_root/bin/willcord"
    if [[ $(id -u) == 0 ]]; then
      if [[ -n "$ca" ]]; then SSL_CERT_FILE="$ca" "$tmp/$name" worker install --system --user "$account"; else "$tmp/$name" worker install --system --user "$account"; fi
      joined=$("$installed" worker join --system "$server")
    else
      local install_env=("WILLCORD_SYSTEM_ROOT=$system_root")
      [[ -z "$ca" ]] || install_env+=("SSL_CERT_FILE=$ca")
      sudo env "${install_env[@]}" "$tmp/$name" worker install --system --user "$account"
      joined=$(sudo env "WILLCORD_SYSTEM_ROOT=$system_root" "$installed" worker join --system "$server")
    fi
  else
    if [[ -n "${WILLCORD_HOME:-}" ]]; then installed="$WILLCORD_HOME/bin/willcord"
    elif [[ "$os" == darwin ]]; then installed="$HOME/Library/Application Support/Willcord/bin/willcord"
    else installed="$HOME/.local/share/willcord/bin/willcord"; fi
    if [[ -n "$ca" ]]; then SSL_CERT_FILE="$ca" "$tmp/$name" worker install; else "$tmp/$name" worker install; fi
    joined=$("$installed" worker join "$server")
  fi
  printf '%s\n' "$joined"
  # The text follows the state join reported: approved needs nothing, denied needs a re-approval.
  case "$joined" in
    *'Authorization: approved'*) printf '\n本机此前已获授权，无需再次批准。等待控制台显示“可执行”，再创建独立会话验证只读任务。\n状态命令：';;
    *'Authorization: rejected'*|*'Authorization: revoked'*) printf '\n本机的授权已被拒绝或撤销，不会自动重新申请。登录 %s，在“机器授权”核对终端指纹后重新批准。\n状态命令：' "$server";;
    *) printf '\n申请已提交。登录 %s，在“机器授权”核对终端指纹并批准。\n' "$server"
       printf '批准后等待“可执行”，再创建独立会话验证只读任务。\n状态命令：';;
  esac
  [[ "$system" == false || $(id -u) == 0 ]] || printf 'sudo '
  quote "$installed"; printf ' worker status'; [[ "$system" == false ]] || printf ' --system'; printf ' --json\n'
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
main() {
  local role="${1:-}"; [[ "$role" == worker || "$role" == main ]] || fail '用法：install.sh main|worker [--version vX.Y.Z] [--server HTTPS_ORIGIN] [--ca /absolute/ca.pem | --ca-fingerprint SHA256] [--system --user ACCOUNT] [--dir PATH]'
  shift
  version=''; server=''; ca=''; fingerprint=''; system=false; account=''; directory="$PWD/willcord"
  while (( $# )); do
    case "$1" in
      --version|--server|--ca|--ca-fingerprint|--user|--dir)
        (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || fail "$1 缺少参数。"
        case "$1" in --version) version="$2";; --server) server="$2";; --ca) ca="$2";; --ca-fingerprint) fingerprint="$2";; --user) account="$2";; --dir) [[ "$role" == main ]] || fail '--dir 只用于 main。'; directory="$2";; esac
        shift 2;;
      --system) system=true; shift;;
      *) fail "未知参数：$1";;
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
  if [[ "$role" == worker ]]; then worker_install; else main_install; fi
}
main "$@"
