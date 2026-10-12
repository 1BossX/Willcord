#!/usr/bin/env bash
set -euo pipefail
docker rm -f willcord-fixture-docker-exited >/dev/null 2>&1 || true
