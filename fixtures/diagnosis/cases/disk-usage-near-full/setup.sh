#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"

BASE="${WILLCORD_FIXTURE_ROOT}/disk-near-full"
MNT="${WILLCORD_DISK_MNT}"
mkdir -p "${BASE}" "${MNT}"

if mountpoint -q "${MNT}" 2>/dev/null; then
  sudo umount "${MNT}" || true
fi
sudo mount -t tmpfs -o size=16M tmpfs "${MNT}"
dd if=/dev/zero of="${MNT}/fill.bin" bs=1M count=14 status=none
