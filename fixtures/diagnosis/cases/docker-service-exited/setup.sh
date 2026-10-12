#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=../../lib/case-lib.sh
source "$(cd "$(dirname "$0")" && pwd)/../../lib/case-lib.sh"

NAME=willcord-fixture-docker-exited
docker rm -f "${NAME}" >/dev/null 2>&1 || true
set +e
docker run --name "${NAME}" --label willcord.fixture=1 alpine:3.20 false
run_rc=$?
set -e
docker inspect "${NAME}" >/dev/null
if [ "${run_rc}" -ne 1 ]; then
  echo "docker run: expected container exit code 1, got ${run_rc}" >&2
  exit "${run_rc}"
fi
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "${NAME}")"
if [ "${exit_code}" -ne 1 ]; then
  echo "container ${NAME}: expected ExitCode 1, got ${exit_code}" >&2
  exit 1
fi
