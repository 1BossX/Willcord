#!/usr/bin/env bash
set -euo pipefail
NAME=willcord-fixture-inconclusive
docker rm -f "${NAME}" >/dev/null 2>&1 || true
docker run -d --name "${NAME}" --label willcord.fixture=1 alpine:3.20 sleep 3600
