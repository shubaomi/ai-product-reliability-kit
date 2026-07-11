#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

PROD_DIR="${PROD_DIR:-/data/prod/ai-product-reliability-kit}"
RELEASES_DIR="${RELEASES_DIR:-$PROD_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$PROD_DIR/current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-$PROD_DIR/previous}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

ops_require_positive_integer "KEEP_RELEASES" "$KEEP_RELEASES"
[[ -d "$RELEASES_DIR" ]] || exit 0
resolved_releases="$(readlink -f -- "$RELEASES_DIR")"
[[ -n "$resolved_releases" && "$resolved_releases" != "/" ]] || ops_die "Refusing unsafe releases directory: $RELEASES_DIR"

current_target="$(ops_resolve_link "$CURRENT_LINK" 2>/dev/null || true)"
previous_target="$(ops_resolve_link "$PREVIOUS_LINK" 2>/dev/null || true)"
kept=0

while IFS= read -r release_name; do
    [[ -n "$release_name" ]] || continue
    release_path="$resolved_releases/$release_name"
    resolved_release="$(ops_assert_release_path "$release_path" "$resolved_releases")"
    if (( kept < KEEP_RELEASES )) || [[ "$resolved_release" == "$current_target" || "$resolved_release" == "$previous_target" ]]; then
        kept=$((kept + 1))
        continue
    fi
    rm -rf -- "$resolved_release"
done < <(find "$resolved_releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort -r)
