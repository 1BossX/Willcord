#!/usr/bin/env bash
# Build a self-contained main node release directory:
#   <out>/apps/server    compiled server, production node_modules, package.json
#   <out>/apps/web/dist  built UI, served by Caddy
#   <out>/migrations     SQL migrations (found relative to apps/server/dist)
#   <out>/deploy         Caddyfile, systemd units and examples
#   <out>/REVISION       git commit
# Native modules (better-sqlite3, argon2) are compiled for this machine: build
# on the same OS, architecture and Node major version as the main host.
set -euo pipefail

out=${1:?usage: deploy/build-main.sh <out-dir> [--skip-build]}
skip_build=${2:-}
root=$(cd "$(dirname "$0")/.." && pwd)
if [ -e "$out" ]; then
  echo "$out already exists" >&2
  exit 1
fi
cd "$root"
if [ "$skip_build" != "--skip-build" ]; then
  pnpm install --frozen-lockfile
  pnpm build
fi
for built in packages/protocol/dist apps/server/dist apps/web/dist; do
  [ -d "$built" ] || { echo "$built missing: run pnpm build first" >&2; exit 1; }
done

mkdir -p "$out/apps/web"
out=$(cd "$out" && pwd)
pnpm --filter @worker-plane/server deploy --prod --legacy "$out/apps/server"
cp -R apps/web/dist "$out/apps/web/dist"
cp -R migrations "$out/migrations"
mkdir -p "$out/deploy"
cp -R deploy/Caddyfile.production deploy/systemd deploy/main.env.example "$out/deploy/"
git rev-parse HEAD > "$out/REVISION"
echo "main node release in $out ($(cat "$out/REVISION"))"
