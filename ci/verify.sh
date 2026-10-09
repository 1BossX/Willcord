#!/usr/bin/env bash
# Every CI check, in order, for one platform: run natively on the macOS runner
# and inside ci/linux.Dockerfile on Linux (ci/in-docker.sh). Ends with the
# release acceptance: the built release directory and release worker, behind
# the production Caddyfile, which therefore needs caddy on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v caddy >/dev/null || { echo "caddy is required on PATH for the release acceptance" >&2; exit 1; }
release="${RUNNER_TEMP:-$(mktemp -d)}/worker-plane-main-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}"
rm -rf "$release"

pnpm install --frozen-lockfile
pnpm protocol:generate
git diff --exit-code -- packages/protocol/src/generated.ts worker/src/generated.rs
cargo fmt --manifest-path worker/Cargo.toml -- --check
cargo test --locked --manifest-path worker/Cargo.toml
cargo test --locked --manifest-path worker/Cargo.toml --features fault-injection
cargo build --locked --manifest-path worker/Cargo.toml
# The P3-C fault tests use this binary; building it here keeps the cold
# compile from competing with the timed end-to-end tests.
cargo build --locked --manifest-path worker/Cargo.toml --features fault-injection --target-dir worker/target/fault
pnpm check
pnpm test
pnpm build
# The main node as deployed: a release directory outside the checkout,
# started the way the systemd unit starts it.
deploy/build-main.sh "$release" --skip-build
deploy/smoke-main.sh "$release"
cargo build --locked --release --manifest-path worker/Cargo.toml
CADDY_BIN="$(command -v caddy)" WP_RELEASE_DIR="$release" WP_WORKER_BIN="$PWD/worker/target/release/worker-plane-worker" \
  pnpm --filter @worker-plane/server test:release
git diff --check
