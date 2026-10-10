#!/usr/bin/env bash
# Start the main node with compose from locally built images and check, through
# Caddy's TLS with its internal CA: it becomes ready, an online backup verifies,
# docker stop (SIGTERM) exits 0 and releases main.lock, and it starts again.
#   deploy/docker/smoke.sh            build local/worker-plane-*:smoke, then test
#   SKIP_BUILD=1 deploy/docker/smoke.sh   test images already tagged
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
tag=${SMOKE_TAG:-smoke}
port=${SMOKE_PORT:-38443}
# An emulated architecture (QEMU) starts much slower.
ready_secs=${SMOKE_READY_SECS:-90}
if [ "${SKIP_BUILD:-}" != 1 ]; then
  docker build -f "$here/Dockerfile" --target main -t "local/worker-plane-main:$tag" "$root"
  docker build -f "$here/Dockerfile" --target caddy -t "local/worker-plane-caddy:$tag" "$root"
fi

work=$(mktemp -d)
project="wp-smoke-$$"
cat > "$work/main.env" <<ENV
PUBLIC_BASE_URL=https://localhost:$port
MODEL_API_KEY=smoke-placeholder
INITIAL_ADMIN_PASSWORD=smoke-$(date +%s)-password
ENV
export WORKER_PLANE_REGISTRY=local WORKER_PLANE_VERSION="$tag" \
  WORKER_PLANE_SITE="localhost:$port" WORKER_PLANE_PORT="$port" \
  WORKER_PLANE_ENV_FILE="$work/main.env"
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

dc exec -T main node dist/admin.js backup /var/lib/worker-plane/smoke-backup.sqlite > "$work/backup.json"
grep -q '"integrity": "ok"' "$work/backup.json" || { cat "$work/backup.json" >&2; exit 1; }
echo "backup: ok"

dc stop main
code=$(docker inspect -f '{{.State.ExitCode}}' "$(dc ps -aq main)")
[ "$code" = 0 ] || { echo "main exited $code after SIGTERM" >&2; exit 1; }
dc run --rm --no-deps -T main node -e \
  "process.exit(require('fs').existsSync('/var/lib/worker-plane/main.lock') ? 1 : 0)" \
  || { echo "main.lock left after docker stop" >&2; exit 1; }
echo "stop: exit 0, lock released"

dc start main
ready
passed=1
echo "docker smoke: ok"
