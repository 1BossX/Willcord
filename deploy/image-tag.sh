#!/usr/bin/env bash
# GHCR image tag for a version git tag: drop the leading v.
# v0.1.0-beta.1 -> 0.1.0-beta.1
set -euo pipefail
tag="${1:-}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || {
  printf 'not a version tag: %s\n' "$tag" >&2
  exit 1
}
printf '%s\n' "${tag#v}"
