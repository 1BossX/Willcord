#!/usr/bin/env bash
# Pages accepts vX.Y.Z and vX.Y.Z-beta.N. Docker tags drop the leading v.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)

formal="$root/deploy/formal-latest-tag.sh"
image="$root/deploy/image-tag.sh"
pages="$root/.github/workflows/pages.yml"
docker="$root/.github/workflows/docker.yml"

bash "$formal" v1.2.3
bash "$formal" v0.1.0-beta.1
bash "$formal" v0.1.0-beta.10
for bad in v0.6.0-rc.1 v0.1.0-beta v0.1 v0.1.0-beta.1-extra 0.1.0-beta.1; do
  if bash "$formal" "$bad" >/dev/null 2>&1; then
    printf 'formal latest unexpectedly accepted %s\n' "$bad" >&2
    exit 1
  fi
done

[[ "$(bash "$image" v0.1.0-beta.1)" == 0.1.0-beta.1 ]]
[[ "$(bash "$image" v0.6.0)" == 0.6.0 ]]
[[ "$(bash "$image" v0.3.0-rc.1)" == 0.3.0-rc.1 ]]
if bash "$image" v0.1 >/dev/null 2>&1; then
  echo 'docker tag unexpectedly accepted v0.1' >&2
  exit 1
fi

grep -F 'bash deploy/formal-latest-tag.sh "$tag"' "$pages" >/dev/null
grep -F 'gh release download "$tag"' "$pages" >/dev/null
if grep -Fq 'cp deploy/install.sh site/install.sh' "$pages"; then
  echo 'pages workflow must not copy install.sh from main' >&2
  exit 1
fi
grep -F 'version=$(bash deploy/image-tag.sh "$GITHUB_REF_NAME")' "$docker" >/dev/null
grep -F 'path: ${{ runner.temp }}/digests' "$docker" >/dev/null
grep -F '"$RUNNER_TEMP/digests/$target-amd64"' "$docker" >/dev/null
python3 "$root/deploy/check-artifact-checkout-order.py" "$root"/.github/workflows/*.yml

printf 'release version tag tests passed\n'
