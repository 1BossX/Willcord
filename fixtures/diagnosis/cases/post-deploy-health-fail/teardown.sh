#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"
rm -f "${WILLCORD_FIXTURE_ROOT}/post-deploy/ready"
