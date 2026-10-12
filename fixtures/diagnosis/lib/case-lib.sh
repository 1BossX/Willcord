# Shared paths for diagnosis fixture setup/teardown (not diagnosis probes).
set -euo pipefail

export WILLCORD_FIXTURE_ROOT="/tmp/willcord-diagnosis-fixtures"
export WILLCORD_DISK_MNT="${WILLCORD_FIXTURE_ROOT}/disk-near-full/mnt"
export WILLCORD_HEALTH_PORT="17891"

mkdir -p "${WILLCORD_FIXTURE_ROOT}"
