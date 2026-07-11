#!/usr/bin/env bash
set -Eeuo pipefail

PROD_DIR="${PROD_DIR:-/data/prod/ai-product-reliability-kit}"
API_APP_NAME="${API_APP_NAME:-${APP_NAME:-ai-product-reliability-kit}}"
WORKER_APP_NAME="${WORKER_APP_NAME:-ai-product-reliability-worker}"
PROD_ENV="${PROD_ENV:-$PROD_DIR/.env.production}"
RELEASES_DIR="${RELEASES_DIR:-$PROD_DIR/releases}"
CURRENT_LINK="${CURRENT_LINK:-$PROD_DIR/current}"
PREVIOUS_LINK="${PREVIOUS_LINK:-$PROD_DIR/previous}"
RELEASE_LOCK="${RELEASE_LOCK:-$PROD_DIR/.release-operation.lock}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
BACKUP_DIR="${BACKUP_DIR:-$PROD_DIR/shared/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
ACCEPTANCE_ATTEMPTS="${ACCEPTANCE_ATTEMPTS:-30}"
ACCEPTANCE_DELAY_SECONDS="${ACCEPTANCE_DELAY_SECONDS:-1}"
ACCEPTANCE_TIMEOUT_SECONDS="${ACCEPTANCE_TIMEOUT_SECONDS:-5}"
PM2_STABILITY_ATTEMPTS="${PM2_STABILITY_ATTEMPTS:-4}"
PM2_STABILITY_DELAY_SECONDS="${PM2_STABILITY_DELAY_SECONDS:-4}"
PM2_MIN_UPTIME_MS="${PM2_MIN_UPTIME_MS:-10000}"
TARGET_RELEASE=""

while (( $# )); do
    case "$1" in
        --release) TARGET_RELEASE="${2:-}"; shift 2 ;;
        *) echo "ERROR: Unknown rollback option: $1" >&2; exit 1 ;;
    esac
done

COMMON_SH="$PROD_DIR/current/scripts/ops/common.sh"
if [[ ! -f "$COMMON_SH" ]]; then
    COMMON_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/ops/common.sh"
fi
[[ -f "$COMMON_SH" ]] || { echo "ERROR: Operations library not found" >&2; exit 1; }
# shellcheck source=scripts/ops/common.sh
. "$COMMON_SH"
OPS_DIR="$(cd "$(dirname "$COMMON_SH")" && pwd)"

for command_name in pm2 curl readlink ln mv node flock; do
    ops_require_command "$command_name"
done
ops_require_positive_integer "KEEP_RELEASES" "$KEEP_RELEASES"
ops_require_positive_integer "ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_ATTEMPTS"
ops_require_positive_integer "ACCEPTANCE_TIMEOUT_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS"
[[ "$ACCEPTANCE_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "ACCEPTANCE_DELAY_SECONDS must be non-negative"
ops_require_positive_integer "PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_ATTEMPTS"
ops_require_positive_integer "PM2_MIN_UPTIME_MS" "$PM2_MIN_UPTIME_MS"
(( PM2_MIN_UPTIME_MS >= 10000 )) || ops_die "PM2_MIN_UPTIME_MS must be at least the 10000ms ecosystem min_uptime"
[[ "$PM2_STABILITY_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "PM2_STABILITY_DELAY_SECONDS must be non-negative"
[[ -d "$RELEASES_DIR" ]] || ops_die "Releases directory does not exist: $RELEASES_DIR"
ops_acquire_release_lock "$RELEASE_LOCK"
ops_load_env_file "$PROD_ENV"
for required_name in DATABASE_URL APR_ADMIN_EMAIL APR_ADMIN_PASSWORD_HASH APR_MASTER_API_KEY APR_INGEST_API_KEY APR_SESSION_SECRET APR_USER_ID_HMAC_SECRET APR_TRUSTED_PROXIES; do
    [[ -n "${!required_name:-}" ]] || ops_die "Missing required env value in $PROD_ENV: $required_name"
done
ops_validate_postgres_url "$DATABASE_URL"
ops_force_production_topology
ops_assert_production_topology
export PUBLIC_BASE_URL="https://reliability.hihongrun.com"

OPS_ROOT="$(cd "$OPS_DIR/../.." && pwd)"
(
    cd "$OPS_ROOT"
    node --input-type=module -e '
      import { loadConfig, validateConfig } from "./apps/dashboard/src/config.mjs";
      validateConfig(loadConfig());
    '
)

original_target="$(ops_resolve_link "$CURRENT_LINK")" || ops_die "Current release symlink is missing"
original_target="$(ops_assert_release_path "$original_target" "$RELEASES_DIR")"

if [[ -n "$TARGET_RELEASE" ]]; then
    ops_validate_identifier "release" "$TARGET_RELEASE"
    target_path="$RELEASES_DIR/$TARGET_RELEASE"
elif target_path="$(ops_resolve_link "$PREVIOUS_LINK" 2>/dev/null)" && [[ -n "$target_path" ]]; then
    :
else
    target_path=""
    while IFS= read -r candidate; do
        [[ -n "$candidate" ]] || continue
        candidate_path="$(ops_assert_release_path "$RELEASES_DIR/$candidate" "$RELEASES_DIR")"
        if [[ "$candidate_path" != "$original_target" ]]; then
            target_path="$candidate_path"
            break
        fi
    done < <(find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | LC_ALL=C sort -r)
fi

[[ -n "$target_path" ]] || ops_die "No previous release is available"
target_path="$(ops_assert_release_path "$target_path" "$RELEASES_DIR")"
[[ "$target_path" != "$original_target" ]] || ops_die "Target release is already current"
[[ ! -e "$target_path/.deploy-failed" ]] || ops_die "Target release is marked as failed: $target_path"
[[ -f "$target_path/.release-ready" ]] || ops_die "Target release is incomplete: $target_path"
ops_assert_release_ready "$target_path"

export APR_CURRENT_LINK="$CURRENT_LINK"
export APR_API_APP_NAME="$API_APP_NAME"
export APR_WORKER_APP_NAME="$WORKER_APP_NAME"

switched=0
handle_failure() {
    local status="$1"
    local step="${2:-unknown}"
    trap - ERR
    set +e
    echo "ERROR: Rollback failed during $step; restoring $original_target" >&2
    if (( switched == 1 )); then
        ops_atomic_symlink "$original_target" "$CURRENT_LINK"
        (ops_reload_pm2_stack "$CURRENT_LINK" "$API_APP_NAME" "$WORKER_APP_NAME") >/dev/null 2>&1 || ops_warn "PM2 reload of original release failed"
        ops_check_platform "http://127.0.0.1:$PORT" "$ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_DELAY_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS" || ops_warn "Original release acceptance did not pass"
        ops_check_pm2_stack_stable "$API_APP_NAME" "$WORKER_APP_NAME" "$PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_DELAY_SECONDS" "$PM2_MIN_UPTIME_MS" >/dev/null 2>&1 || ops_warn "Original PM2 stack did not prove stable"
        pm2 save >/dev/null 2>&1 || true
    fi
    exit "$status"
}
trap 'handle_failure "$?" "line-$LINENO"' ERR

echo "Creating pre-rollback backup"
DATABASE_URL="$DATABASE_URL" \
BACKUP_DIR="$BACKUP_DIR" \
BACKUP_RETENTION_DAYS="$BACKUP_RETENTION_DAYS" \
BACKUP_LABEL="prerollback-$(basename "$target_path")" \
bash "$OPS_DIR/backup-postgres.sh"

echo "Switching current release to: $target_path"
ops_atomic_symlink "$target_path" "$CURRENT_LINK"
switched=1
if ! (ops_reload_pm2_stack "$CURRENT_LINK" "$API_APP_NAME" "$WORKER_APP_NAME"); then
    handle_failure 1 "PM2 stack reload"
fi
if ! (ops_check_platform "http://127.0.0.1:$PORT" "$ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_DELAY_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS"); then
    handle_failure 1 "HTTP acceptance"
fi
if ! (ops_check_pm2_stack_stable "$API_APP_NAME" "$WORKER_APP_NAME" "$PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_DELAY_SECONDS" "$PM2_MIN_UPTIME_MS"); then
    handle_failure 1 "PM2 stability acceptance"
fi
if ! pm2 save; then
    handle_failure 1 "PM2 state save"
fi
ops_atomic_symlink "$original_target" "$PREVIOUS_LINK"
trap - ERR

if ! PROD_DIR="$PROD_DIR" RELEASES_DIR="$RELEASES_DIR" CURRENT_LINK="$CURRENT_LINK" PREVIOUS_LINK="$PREVIOUS_LINK" KEEP_RELEASES="$KEEP_RELEASES" bash "$OPS_DIR/prune-releases.sh"; then
    ops_warn "Release retention failed; rollback remains active"
fi

echo "Rollback completed: $CURRENT_LINK -> $target_path"
