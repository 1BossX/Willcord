#!/usr/bin/env bash
# Release files for this platform into ./release: the worker binary and, on
# Linux, the main node tarball (built and smoke-tested here first).
set -euo pipefail
cd "$(dirname "$0")/.."
tag=${GITHUB_REF_NAME:?release tag required}
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
mkdir -p release
pnpm install --frozen-lockfile
cargo build --locked --release --manifest-path worker/Cargo.toml
cp worker/target/release/worker-plane-worker "release/worker-plane-worker-${tag}-${os}-${arch}"
if [ "$os" = linux ]; then
  work=$(mktemp -d)
  dir="$work/worker-plane-main-${tag}"
  deploy/build-main.sh "$dir"
  deploy/smoke-main.sh "$dir"
  tar -C "$work" -czf "release/worker-plane-main-${tag}-linux-${arch}-node24.tar.gz" "worker-plane-main-${tag}"
fi
cd release
for f in *; do case "$f" in *.sha256) ;; *) sha256sum "$f" > "$f.sha256" 2>/dev/null || shasum -a 256 "$f" > "$f.sha256" ;; esac; done
ls -l
