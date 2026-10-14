#!/usr/bin/env bash
# Validate deploy Caddy configs with Caddy 2.10.x (no Docker required).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
version=${CADDY_VERSION:-2.10.2}
cache=${CADDY_VALIDATE_CACHE:-/tmp/willcord-caddy-validate}
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
arch=$(uname -m)
case "$arch" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
bin="$cache/caddy-$version-$os-$arch"
if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  url="https://github.com/caddyserver/caddy/releases/download/v${version}/caddy_${version}_${os}_${arch}.tar.gz"
  tmp=$(mktemp -d)
  curl -fsSL "$url" | tar -xz -C "$tmp" caddy
  mv "$tmp/caddy" "$bin"
  rm -rf "$tmp"
fi

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/etc/caddy" "$stage/release/deploy/caddy"
sed 's|import /etc/caddy/willcord-routes.caddy|import willcord-routes.caddy|' \
  "$root/deploy/docker/Caddyfile" > "$stage/etc/caddy/Caddyfile"
cp "$root/deploy/caddy/willcord-routes.caddy" "$stage/etc/caddy/willcord-routes.caddy"
WILLCORD_SITE=localhost:8443 "$bin" validate --config "$stage/etc/caddy/Caddyfile" --adapter caddyfile

mkdir -p "$stage/release/apps/web/dist"
touch "$stage/release/apps/web/dist/index.html"
cp "$root/deploy/Caddyfile.production" "$stage/release/deploy/Caddyfile.production"
cp "$root/deploy/caddy/willcord-routes.caddy" "$stage/release/deploy/caddy/willcord-routes.caddy"
WILLCORD_SITE=plane.internal:8443 WILLCORD_ROOT="$stage/release" \
  "$bin" validate --config "$stage/release/deploy/Caddyfile.production" --adapter caddyfile

echo "caddy validate: ok"
