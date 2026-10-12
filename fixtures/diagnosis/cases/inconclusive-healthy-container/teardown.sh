#!/usr/bin/env bash
set -euo pipefail
docker rm -f willcord-fixture-inconclusive >/dev/null 2>&1 || true
