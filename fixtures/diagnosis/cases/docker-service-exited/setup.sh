#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"

NAME=willcord-fixture-docker-exited
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run --name "${NAME}" --label willcord.fixture=1 alpine:3.20 /bin/sh -c "exit 1"
