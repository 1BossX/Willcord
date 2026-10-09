#!/usr/bin/env bash
# Start a main node from a release directory (deploy/build-main.sh), the way
# the systemd unit does, and check: it becomes ready, an online backup
# verifies, and SIGTERM stops it cleanly and releases the data directory lock.
set -euo pipefail

release=$(cd "${1:?usage: deploy/smoke-main.sh <release-dir>}" && pwd)
work=$(mktemp -d)
data="$work/data"
port=${SMOKE_PORT:-38117}
cleanup() {
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; fi
  rm -rf "$work"
}
trap cleanup EXIT

cd "$release/apps/server"
DATA_DIR="$data" PORT="$port" PUBLIC_BASE_URL=https://localhost:8443 \
  MODEL_API_KEY=smoke-placeholder INITIAL_ADMIN_PASSWORD="smoke-$(date +%s)-password" \
  node dist/main.js > "$work/main.log" 2>&1 &
pid=$!

health=""
for _ in $(seq 1 60); do
  health=$(curl -fsS "http://127.0.0.1:$port/health" 2>/dev/null || true)
  case "$health" in *'"scheduling_ready":true'*) break ;; esac
  kill -0 "$pid" 2>/dev/null || { cat "$work/main.log" >&2; echo "main node exited" >&2; exit 1; }
  sleep 1
done
case "$health" in
  *'"scheduling_ready":true'*'"dispatch_paused":null'*) echo "health: $health" ;;
  *) cat "$work/main.log" >&2; echo "not ready: $health" >&2; exit 1 ;;
esac

DATA_DIR="$data" node dist/admin.js backup "$work/backup.sqlite" > "$work/backup.json"
grep -q '"integrity": "ok"' "$work/backup.json" || { cat "$work/backup.json" >&2; exit 1; }
node dist/admin.js verify "$work/backup.sqlite" > /dev/null
echo "backup: ok"

kill -TERM "$pid"
wait "$pid" || { cat "$work/main.log" >&2; echo "main node did not exit cleanly" >&2; exit 1; }
pid=""
[ ! -e "$data/main.lock" ] || { echo "main.lock left after SIGTERM" >&2; exit 1; }
echo "stop: clean, lock released"
