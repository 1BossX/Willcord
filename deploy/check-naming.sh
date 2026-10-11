#!/usr/bin/env bash
# The product, repository, packages, CLI, services and paths are all named
# willcord, and the GitHub organization is BossOptional. Fail when an old name
# comes back, except in the historical records (the migration guide, the naming
# decision records and the first-run walkthrough), which describe it on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0

if git grep -nEi 'worker[-_ ]?plane|workerplane' -- . \
  ':!docs/brand/naming-shortlist.md' ':!docs/brand/telekine-proposal.md' \
  ':!docs/migrating-to-willcord.md' \
  ':!docs/dev/acceptance/first-run-walkthrough.md' \
  ':!deploy/check-naming.sh'; then
  echo '旧名称 worker-plane 不应再出现；请改用 willcord。' >&2
  fail=1
fi

# The organization was renamed from 1BossX to BossOptional. GitHub Pages and
# GHCR paths do not redirect, so a leftover old slug breaks installs.
if git grep -nEi '1bossx' -- . \
  ':!docs/migrating-to-willcord.md' \
  ':!deploy/check-naming.sh'; then
  echo '旧组织名 1BossX 不应再出现；请改用 BossOptional。' >&2
  fail=1
fi

exit "$fail"
