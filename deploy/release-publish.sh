#!/usr/bin/env bash
# Attach artifacts to the Release for the pushed tag. A published Release is
# intentionally never repaired here: publishing is a separate human decision.
set -euo pipefail

fail() { printf 'release publish failed: %s\n' "$*" >&2; exit 1; }

main() {
  local tag="${GITHUB_REF_NAME:-}" repo="${GITHUB_REPOSITORY:-}" directory="${RELEASE_DIR:-release}"
  [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || fail 'GITHUB_REF_NAME must be a vX.Y.Z tag.'
  [[ -n "$repo" ]] || fail 'GITHUB_REPOSITORY is required.'
  [[ -d "$directory" ]] || fail "release directory does not exist: $directory"

  shopt -s nullglob
  local assets=("$directory"/*)
  (( ${#assets[@]} > 0 )) || fail "release directory is empty: $directory"

  local expected_prerelease=false
  [[ "$tag" != *-* ]] || expected_prerelease=true

  if gh release view "$tag" --repo "$repo" --json isDraft >/dev/null 2>&1; then
    local draft prerelease
    draft=$(gh release view "$tag" --repo "$repo" --json isDraft --jq .isDraft)
    prerelease=$(gh release view "$tag" --repo "$repo" --json isPrerelease --jq .isPrerelease)
    [[ "$draft" == true ]] || fail "Release $tag is already published; refuse to create an untagged draft or change a published Release."
    [[ "$prerelease" == "$expected_prerelease" ]] || fail "Draft Release $tag has prerelease=$prerelease, expected $expected_prerelease."
    gh release upload "$tag" "${assets[@]}" --repo "$repo" --clobber
    return
  fi

  local args=(release create "$tag" "${assets[@]}" --repo "$repo" --verify-tag --draft
    --title "Willcord $tag"
    --notes 'One-line installation: README.md and docs/installation.md; upgrade: docs/operations.md. Linux workers need glibc 2.17 or newer. Verify each file against its .sha256.')
  [[ "$expected_prerelease" == true ]] && args+=(--prerelease)
  gh "${args[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
