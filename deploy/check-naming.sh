#!/usr/bin/env bash
# The product, repository, packages, CLI, services and paths are all named
# willcord. Fail when the old name comes back, except in the historical records
# and the migration guide, which describe it on purpose.
set -euo pipefail
cd "$(dirname "$0")/.."
if git grep -nEi 'worker[-_ ]?plane|workerplane' -- . \
  ':!docs/research' ':!docs/proposals' ':!output' \
  ':!docs/brand/naming-shortlist.md' ':!docs/brand/telekine-proposal.md' \
  ':!docs/p2-development.md' ':!docs/migrating-to-willcord.md' \
  ':!deploy/check-naming.sh'; then
  echo '旧名称 worker-plane 不应再出现；请改用 willcord。' >&2
  exit 1
fi
