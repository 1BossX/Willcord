#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"
# Health server process is started by deploy/test-diagnosis-fixtures.py (avoids shell background in probes).
mkdir -p "${WILLCORD_FIXTURE_ROOT}/post-deploy"
: > "${WILLCORD_FIXTURE_ROOT}/post-deploy/ready"
