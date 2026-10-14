#!/usr/bin/env bash
# Start the main node with compose from locally built images and check, through
# Caddy's TLS with its internal CA: it becomes ready, an online backup verifies,
# docker stop (SIGTERM) exits 0 and releases main.lock, and it starts again.
#   deploy/docker/smoke.sh            build local/willcord-*:smoke, then test
#   SKIP_BUILD=1 deploy/docker/smoke.sh   test images already tagged
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
tag=${SMOKE_TAG:-smoke}
port=${SMOKE_PORT:-38443}
# Not 8480, so the loopback Origin rewrite is checked against the configured host port.
local_port=${SMOKE_LOCAL_PORT:-38480}
# An emulated architecture (QEMU) starts much slower.
ready_secs=${SMOKE_READY_SECS:-90}
if [ "${SKIP_BUILD:-}" != 1 ]; then
  docker build -f "$here/Dockerfile" --target main -t "local/willcord-main:$tag" "$root"
  docker build -f "$here/Dockerfile" --target caddy -t "local/willcord-caddy:$tag" "$root"
fi

work=$(mktemp -d)
project="wp-smoke-$$"
cat > "$work/main.env" <<ENV
PUBLIC_BASE_URL=https://localhost:$port
MODEL_API_KEY=smoke-placeholder
INITIAL_ADMIN_PASSWORD=smoke-$(date +%s)-password
ENV
export WILLCORD_REGISTRY=local WILLCORD_VERSION="$tag" \
  WILLCORD_SITE="localhost:$port" WILLCORD_PORT="$port" \
  WILLCORD_BIND_IP=127.0.0.1 WILLCORD_LOCAL_PORT="$local_port" \
  WILLCORD_ENV_FILE="$work/main.env"
dc() { docker compose -p "$project" -f "$here/compose.yaml" "$@"; }
passed=""
cleanup() {
  [ -n "$passed" ] || dc logs --no-color >&2 || true
  dc down -v --remove-orphans > /dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

ready() {
  for _ in $(seq 1 "$ready_secs"); do
    if [ -s "$work/ca.pem" ] || dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/ca.pem" > /dev/null 2>&1; then
      health=$(curl -fsS --cacert "$work/ca.pem" "https://localhost:$port/health" 2>/dev/null || true)
      case "$health" in *'"scheduling_ready":true'*) echo "health: $health"; return 0 ;; esac
    fi
    sleep 1
  done
  echo "not ready: ${health:-no response}" >&2
  return 1
}

dc up -d
ready
case "$health" in *'"dispatch_paused":null'*) ;; *) echo "dispatch should not be paused" >&2; exit 1 ;; esac

wrong_host=$(curl -sk --cacert "$work/ca.pem" -H "Host: willcord-wrong-host.example:$port" \
  -o "$work/wrong-host.html" -w '%{http_code}' "https://127.0.0.1:$port/")
[ "$wrong_host" = "421" ] || { echo "wrong Host expected 421, got $wrong_host" >&2; cat "$work/wrong-host.html" >&2; exit 1; }
grep -q '主机名不正确' "$work/wrong-host.html" || { echo "421 page missing site hint" >&2; exit 1; }
curl -fsS --cacert "$work/ca.pem" "https://localhost:$port/.well-known/willcord/ca.pem" | openssl x509 -inform PEM -noout -subject > /dev/null
curl -fsS --cacert "$work/ca.pem" "https://localhost:$port/.well-known/willcord/chain.pem" | openssl x509 -inform PEM -noout -subject > /dev/null
echo "caddy host/ca: ok"

dc exec -T main node dist/admin.js backup /var/lib/willcord/smoke-backup.sqlite > "$work/backup.json"
grep -q '"integrity": "ok"' "$work/backup.json" || { cat "$work/backup.json" >&2; exit 1; }
echo "backup: ok"

password=$(sed -n 's/^INITIAL_ADMIN_PASSWORD=//p' "$work/main.env")
loopback_login() {
  curl -sS -o /dev/null -D "$work/login.headers" -w '%{http_code}' \
    -H "Origin: $1" -H 'content-type: application/json' \
    --data "{\"password\":\"$password\"}" "http://127.0.0.1:$local_port/auth/login"
}
[ "$(loopback_login "http://localhost:$local_port")" = 200 ] \
  || { echo "loopback login refused on :$local_port" >&2; exit 1; }
grep -qi '^set-cookie: session=' "$work/login.headers" \
  && ! grep -qiE '^set-cookie:.*; ?secure' "$work/login.headers" \
  || { cat "$work/login.headers" >&2; echo "loopback session cookie: wrong attributes" >&2; exit 1; }
[ "$(loopback_login "http://localhost:$((local_port + 1))")" = 403 ] \
  || { echo "another local port was not refused" >&2; exit 1; }
echo "loopback login: ok"

main_id=$(dc ps -aq main)
docker kill -s SIGKILL "$main_id" > /dev/null
sleep 1
status=$(docker inspect -f '{{.State.Status}}' "$main_id")
[ "$status" = "exited" ] || { echo "main not exited after SIGKILL: $status" >&2; exit 1; }
policy=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$main_id")
[ "$policy" = "no" ] || { echo "main restart policy expected no, got $policy" >&2; exit 1; }
dc run --rm --no-deps -T main node -e \
  "process.exit(require('fs').existsSync('/var/lib/willcord/main.lock') ? 0 : 1)" \
  || { echo "main.lock missing after SIGKILL" >&2; exit 1; }
started_before=$(docker inspect -f '{{.State.StartedAt}}' "$main_id")
dc start main
refused=0
for _ in $(seq 1 15); do
  started_now=$(docker inspect -f '{{.State.StartedAt}}' "$main_id")
  status=$(docker inspect -f '{{.State.Status}}' "$main_id")
  if [ -s "$work/ca.pem" ]; then
    health=$(curl -fsS --cacert "$work/ca.pem" "https://localhost:$port/health" 2>/dev/null || true)
    case "$health" in *'"scheduling_ready":true'*)
      echo "main served /health with stale main.lock" >&2
      exit 1
    ;; esac
  fi
  if [ "$started_now" != "$started_before" ] && [ "$status" = "exited" ]; then
    refused=1
    break
  fi
  sleep 1
done
[ "$refused" = 1 ] || { echo "main did not run and exit after start with stale main.lock" >&2; exit 1; }
status=$(docker inspect -f '{{.State.Status}}' "$main_id")
[ "$status" = "exited" ] || { echo "main still $status after stale-lock start" >&2; exit 1; }
dc run --rm --no-deps -T main node -e \
  "process.exit(require('fs').existsSync('/var/lib/willcord/main.lock') ? 0 : 1)" \
  || { echo "main.lock missing before operator clear" >&2; exit 1; }
dc run --rm --no-deps -T main node -e \
  "require('fs').rmSync('/var/lib/willcord/main.lock',{recursive:true})"
dc start main
ready
echo "crash lock: SIGKILL left main.lock, start refused until cleared"

dc stop main
code=$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq main)")
[ "$code" = 0 ] || { echo "main exited $code after SIGTERM" >&2; exit 1; }
dc run --rm --no-deps -T main node -e \
  "process.exit(require('fs').existsSync('/var/lib/willcord/main.lock') ? 1 : 0)" \
  || { echo "main.lock left after docker stop" >&2; exit 1; }
echo "stop: exit 0, lock released"

dc start main
ready
passed=1
echo "docker smoke: ok"
