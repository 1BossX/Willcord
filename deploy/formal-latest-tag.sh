#!/usr/bin/env bash
# Accept the tag Pages copies an installer from. vX.Y.Z and vX.Y.Z-beta.N are
# formal releases. rc and any other hyphenated tag are not.
set -euo pipefail
tag="${1:-}"
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$ ]] || {
  printf 'latest Release is not a formal version: %s\n' "$tag" >&2
  exit 1
}
