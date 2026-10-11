#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
source "$root/deploy/release-publish.sh"

test_dir=$(mktemp -d "${TMPDIR:-/tmp}/willcord-release-publish.XXXXXX")
trap 'rm -rf "$test_dir"' EXIT
release_dir="$test_dir/release"
mkdir "$release_dir"
: > "$release_dir/install.sh"

mock_state=absent
mock_draft=true
mock_prerelease=true
mock_log="$test_dir/gh.log"

gh() {
  if [[ "$1 $2" == 'release view' ]]; then
    [[ "$mock_state" == existing ]] || return 1
    case " $* " in
      *' --json isDraft '*) printf '%s\n' "$mock_draft";;
      *' --json isPrerelease '*) printf '%s\n' "$mock_prerelease";;
      *) printf '{}\n';;
    esac
    return
  fi
  printf '%q ' "$@" >> "$mock_log"; printf '\n' >> "$mock_log"
}

run() {
  : > "$mock_log"
  GITHUB_REF_NAME="$1" GITHUB_REPOSITORY='BossOptional/Willcord' RELEASE_DIR="$release_dir" main
}

mock_state=absent
run v0.3.0-rc.1
grep -F -- '--verify-tag' "$mock_log" >/dev/null
grep -F -- '--draft' "$mock_log" >/dev/null
grep -F -- '--prerelease' "$mock_log" >/dev/null

mock_state=existing; mock_draft=true; mock_prerelease=true
run v0.3.0-rc.1
grep -F -- 'release upload v0.3.0-rc.1' "$mock_log" >/dev/null
! grep -F -- 'release create' "$mock_log" >/dev/null

mock_draft=false
if (run v0.3.0-rc.1) >/dev/null 2>&1; then
  echo 'published release unexpectedly accepted' >&2; exit 1
fi
[[ ! -s "$mock_log" ]]

mock_draft=true; mock_prerelease=false
if (run v0.3.0-rc.1) >/dev/null 2>&1; then
  echo 'prerelease mismatch unexpectedly accepted' >&2; exit 1
fi
[[ ! -s "$mock_log" ]]

mock_state=absent
run v0.3.0
grep -F -- '--draft' "$mock_log" >/dev/null
! grep -F -- '--prerelease' "$mock_log" >/dev/null

printf 'release publish tests passed\n'
