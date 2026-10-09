#!/usr/bin/env bash
# Run a command from the checkout inside the Linux CI image:
#   ci/in-docker.sh ci/verify.sh
# The checkout is mounted at /work and dependency caches live in a named
# volume per runner user. Files the container creates in the checkout are
# handed back to the caller, so the runner can clean the workspace afterwards.
# Use a checkout of its own: node_modules and worker/target become Linux builds.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sum=$( (sha256sum "$root/ci/linux.Dockerfile" 2>/dev/null || shasum -a 256 "$root/ci/linux.Dockerfile") | cut -c1-12)
image="worker-plane-ci:$sum"
docker build --quiet -t "$image" -f "$root/ci/linux.Dockerfile" "$root/ci" > /dev/null
owner="$(id -u):$(id -g)"
# --init reaps the process groups tests stop, so "the process is gone" holds.
exec docker run --rm --init \
  -v "$root":/work -w /work \
  -v "worker-plane-ci-cache-$(id -u)":/cache \
  -e CARGO_HOME=/cache/cargo -e npm_config_store_dir=/cache/pnpm-store -e CI=true \
  -e GITHUB_RUN_ID -e GITHUB_RUN_ATTEMPT -e GITHUB_REF_NAME -e OWNER="$owner" \
  "$image" bash -c 'git config --global --add safe.directory /work; status=0; "$@" || status=$?; chown -R "$OWNER" /work; exit $status' bash "$@"
