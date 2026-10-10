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
prompt() {
  local variable="$1" label="$2" fallback="${3:-}" secret="${4:-}" value
  [[ -r /dev/tty ]] || fail "初始化需要交互终端 /dev/tty。"
  # Disable echo before displaying a secret prompt, including fast paste input.
  if [[ "$secret" == secret ]]; then
    tty_state=$(stty -g </dev/tty); stty -echo </dev/tty
  fi
  printf '%s%s: ' "$label" "${fallback:+ [$fallback]}" >/dev/tty
  IFS= read -r value </dev/tty || fail "输入已取消。"
  if [[ "$secret" == secret ]]; then
    stty "$tty_state" </dev/tty; tty_state=''; printf '\n' >/dev/tty
  fi
  printf -v "$variable" '%s' "${value:-$fallback}"
}
# Preserve arbitrary single-line secrets with Compose's double-quote rules.
# $$ prevents interpolation; backslashes and double quotes are escaped first.
env_line() {
  local value="$2"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "配置值不能包含换行。"
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  printf '%s="%s"\n' "$1" "$value"
}
resolve_version() {
  local resolved stable=true
  if [[ -z "$version" ]]; then
    # With no Release, GitHub redirects /releases/latest to /releases.
    resolved=$(curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 60 -o /dev/null -w '%{url_effective}' "https://github.com/1BossX/Willcord/releases/latest") || resolved=''
    [[ "$resolved" == */releases/tag/* ]] || fail "没有可访问的正式 Release。请等待发布，或用 --version 指定已发布版本。"
    version=${resolved##*/}
    [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "最新 Release 不是正式版本 vX.Y.Z：${version}。"
  fi
  # Pre-releases (vX.Y.Z-rc.N) are installed only when named with --version.
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail "版本必须是 vX.Y.Z，或显式指定的预发布版本 vX.Y.Z-rc.N。"
  [[ "$version" != *-* ]] || stable=false
  fetch "https://api.github.com/repos/1BossX/Willcord/releases/tags/$version" "$tmp/release.json"
  grep -Eq '"draft":[[:space:]]*false' "$tmp/release.json" || fail "版本尚未发布。"
  if [[ "$stable" == true ]]; then
    grep -Eq '"prerelease":[[:space:]]*false' "$tmp/release.json" || fail "${version} 标记为预发布，不是正式版本。"
    printf '安装版本：%s\n' "$version"
  else
    printf '安装预发布版本：%s（仅用于验收）\n' "$version"
  fi
  release="https://github.com/1BossX/Willcord/releases/download/$version"
}
worker_install() {
  [[ -n "$server" && -n "$ca" ]] || fail "worker 需要 --server HTTPS_ORIGIN --ca /absolute/ca.pem。"
  origin "$server"
  [[ "$ca" == /* && -r "$ca" && -f "$ca" ]] || fail "CA 必须是可读的绝对文件路径。请先安全复制主节点导出的 ca.pem。"
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
  curl --fail --silent --show-error --cacert "$ca" --connect-timeout 5 --max-time 15 "$server/health" -o "$tmp/worker-health.json" || fail "无法通过 CA 验证主节点 HTTPS，请检查证书、地址与网络。"
  local name="worker-plane-worker-$version-$os-$arch" installed
  verified "$name"
  chmod 700 "$tmp/$name"
  if [[ "$system" == true ]]; then
    local system_root="${WORKER_PLANE_SYSTEM_ROOT:-}"
    if [[ -z "$system_root" ]]; then
      if [[ "$os" == darwin ]]; then system_root='/Library/Application Support/WorkerPlane'; else system_root=/var/lib/worker-plane-system; fi
    fi
    installed="$system_root/bin/worker"
    if [[ $(id -u) == 0 ]]; then
      SSL_CERT_FILE="$ca" "$tmp/$name" install --system --user "$account"
      "$installed" join --system "$server"
    else
      sudo env "SSL_CERT_FILE=$ca" "WORKER_PLANE_SYSTEM_ROOT=$system_root" "$tmp/$name" install --system --user "$account"
      sudo env "WORKER_PLANE_SYSTEM_ROOT=$system_root" "$installed" join --system "$server"
    fi
  else
    if [[ -n "${WORKER_PLANE_HOME:-}" ]]; then installed="$WORKER_PLANE_HOME/bin/worker"
    elif [[ "$os" == darwin ]]; then installed="$HOME/Library/Application Support/WorkerPlane/bin/worker"
    else installed="$HOME/.local/share/worker-plane/bin/worker"; fi
    SSL_CERT_FILE="$ca" "$tmp/$name" install
    "$installed" join "$server"
  fi
  printf '\n申请已提交。登录 %s，在“机器授权”核对终端指纹并批准。\n' "$server"
  printf '批准后等待“可执行”，再创建独立会话验证只读任务。\n状态命令：'
  [[ "$system" == false || $(id -u) == 0 ]] || printf 'sudo '
  quote "$installed"; printf ' status'; [[ "$system" == false ]] || printf ' --system'; printf ' --json\n'
}
main_install() {
  [[ "$os" == linux ]] || fail "主节点向导支持 Linux amd64/arm64。"
  [[ "$system" == false && -z "$account" && -z "$ca" ]] || fail "main 不接受 --system、--user 或 --ca。"
  need docker; need stty
  docker compose version >/dev/null || fail "请先安装 Docker Compose v2。"
  docker info >/dev/null || fail "无法访问 Docker，请检查 Docker 服务及当前账户权限。"
  [[ -d "$directory" ]] || mkdir -p "$directory"
  directory=$(cd "$directory" && pwd)
  for existing in compose.yaml .env main.env ca.pem; do
    [[ ! -e "$directory/$existing" && ! -L "$directory/$existing" ]] || fail "目录已有 ${existing}，拒绝覆盖，请使用新的 --dir。"
  done
  if [[ -z "$server" ]]; then prompt server '浏览器和 worker 可访问的 HTTPS 地址' 'https://plane.internal:8443'; fi
  origin "$server"
  local provider model api_key password
  prompt provider '模型 provider' openrouter
  prompt model '模型名称' deepseek/deepseek-v4.1-flash
  prompt api_key '模型 API key' '' secret
  [[ -n "$api_key" ]] || fail "模型 API key 不能为空。"
  prompt password '首次管理员密码（至少 16 字符）' '' secret
  [[ ${#password} -ge 16 ]] || fail "管理员密码至少需要 16 字符。"
  verified compose.yaml
  # Each install directory receives distinct volumes, rather than sharing the
  # template's fixed project name with another deployment on the same host.
  # Exclusive creation also protects against another initializer racing us.
  set -C
  cat "$tmp/compose.yaml" > "$directory/compose.yaml"
  {
    env_line COMPOSE_PROJECT_NAME "worker-plane-$(printf '%s' "$directory" | sha256_stdin | cut -c1-12)"
    env_line WORKER_PLANE_VERSION "${version#v}"
    env_line WORKER_PLANE_SITE "$site"
    env_line WORKER_PLANE_PORT "$port"
  } > "$directory/.env"
  {
    env_line PUBLIC_BASE_URL "$server"
    env_line MODEL_PROVIDER "$provider"
    env_line MODEL_NAME "$model"
    env_line MODEL_API_KEY "$api_key"
    env_line INITIAL_ADMIN_PASSWORD "$password"
  } > "$directory/main.env"
  set +C
  unset api_key password
  cd "$directory"
  printf '部署目录：%s\n' "$directory"
  # From here on, keep the files/volumes if startup fails.
  trap 'printf "启动未完成，配置和数据已保留。请在部署目录执行 docker compose logs main caddy 查看原因；修复后执行 docker compose up -d。\n" >&2' ERR
  docker compose pull
  docker compose up -d
  local ready=false attempt
  for attempt in {1..60}; do
    if docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./ca.pem >/dev/null 2>&1 && curl --fail --silent --show-error --cacert ./ca.pem --connect-timeout 2 --max-time 5 "$server/health" -o "$tmp/health.json" 2>/dev/null && grep -Eq '"scheduling_ready":[[:space:]]*true' "$tmp/health.json"; then ready=true; break; fi
    sleep 2
  done
  [[ "$ready" == true ]] || { printf 'HTTPS 未就绪。检查主机名解析、端口和 docker compose logs main caddy。\n' >&2; return 1; }
  chmod 644 ca.pem
  sed '/^INITIAL_ADMIN_PASSWORD=/d' main.env > "$tmp/main.env"
  cat "$tmp/main.env" > main.env
  docker compose up -d main
  ready=false
  for attempt in {1..60}; do
    if curl --fail --silent --cacert ./ca.pem --connect-timeout 2 --max-time 5 "$server/health" -o "$tmp/health.json" && grep -Eq '"scheduling_ready":[[:space:]]*true' "$tmp/health.json"; then ready=true; break; fi
    sleep 2
  done
  [[ "$ready" == true ]] || { printf '移除首次密码后的主节点未就绪，请查看 docker compose logs main。\n' >&2; return 1; }
  trap - ERR
  printf '\n主节点已就绪：%s\n根证书：%s/ca.pem\n' "$server" "$directory"
  printf '请先让浏览器信任此根证书，并安全复制到执行机器。登录控制台，在“机器授权 → 添加机器”复制安装命令。\n'
}
sha256_stdin() { if command -v shasum >/dev/null 2>&1; then shasum -a 256; else sha256sum; fi; }
main() {
  local role="${1:-}"; [[ "$role" == worker || "$role" == main ]] || fail '用法：install.sh main|worker [--version vX.Y.Z] [--server HTTPS_ORIGIN] [--ca /absolute/ca.pem] [--system --user ACCOUNT] [--dir PATH]'
  shift
  version=''; server=''; ca=''; system=false; account=''; directory="$PWD/worker-plane"
  while (( $# )); do
    case "$1" in
      --version|--server|--ca|--user|--dir)
        (( $# >= 2 )) && [[ -n "$2" && "$2" != --* ]] || fail "$1 缺少参数。"
        case "$1" in --version) version="$2";; --server) server="$2";; --ca) ca="$2";; --user) account="$2";; --dir) [[ "$role" == main ]] || fail '--dir 只用于 main。'; directory="$2";; esac
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
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/worker-plane-install.XXXXXX")
  tty_state=''
  trap '[[ -z "$tty_state" ]] || stty "$tty_state" </dev/tty; rm -rf "$tmp"' EXIT
  resolve_version
  if [[ "$role" == worker ]]; then worker_install; else main_install; fi
}
main "$@"
