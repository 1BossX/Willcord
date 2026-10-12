#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"

MNT="${WILLCORD_DISK_MNT}"
if mountpoint -q "${MNT}" 2>/dev/null; then
  sudo umount "${MNT}"
fi
rm -rf "${WILLCORD_FIXTURE_ROOT}/disk-near-full"
