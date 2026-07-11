#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${SOURCE_DIR:-/data/claude_project/ai-product-reliability-kit}"
PROD_DIR="${PROD_DIR:-/data/prod/ai-product-reliability-kit}"
API_APP_NAME="${API_APP_NAME:-${APP_NAME:-ai-product-reliability-kit}}"
WORKER_APP_NAME="${WORKER_APP_NAME:-ai-product-reliability-worker}"
DOMAIN="reliability.hihongrun.com"
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
ALLOW_DIRTY_SOURCE="${ALLOW_DIRTY_SOURCE:-NO}"

COMMON_SH="$SOURCE_DIR/scripts/ops/common.sh"
[[ -f "$COMMON_SH" ]] || { echo "ERROR: Missing operations library: $COMMON_SH" >&2; exit 1; }
# shellcheck source=scripts/ops/common.sh
. "$COMMON_SH"

for command_name in rsync npm node pm2 curl readlink ln mv git flock; do
    ops_require_command "$command_name"
done
ops_require_positive_integer "KEEP_RELEASES" "$KEEP_RELEASES"
ops_require_positive_integer "BACKUP_RETENTION_DAYS" "$BACKUP_RETENTION_DAYS"
ops_require_positive_integer "ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_ATTEMPTS"
ops_require_positive_integer "ACCEPTANCE_TIMEOUT_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS"
[[ "$ACCEPTANCE_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "ACCEPTANCE_DELAY_SECONDS must be non-negative"
ops_require_positive_integer "PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_ATTEMPTS"
ops_require_positive_integer "PM2_MIN_UPTIME_MS" "$PM2_MIN_UPTIME_MS"
(( PM2_MIN_UPTIME_MS >= 10000 )) || ops_die "PM2_MIN_UPTIME_MS must be at least the 10000ms ecosystem min_uptime"
[[ "$PM2_STABILITY_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "PM2_STABILITY_DELAY_SECONDS must be non-negative"
[[ -d "$SOURCE_DIR/apps/dashboard" ]] || ops_die "Invalid source directory: $SOURCE_DIR"
[[ "$SOURCE_DIR" != "$PROD_DIR" ]] || ops_die "SOURCE_DIR and PROD_DIR must differ"
[[ ! -e "$SOURCE_DIR/.env" && ! -e "$SOURCE_DIR/.env.local" ]] || ops_die "Local env files must not exist in the production source directory"
[[ "$ALLOW_DIRTY_SOURCE" == "NO" || "$ALLOW_DIRTY_SOURCE" == "YES" ]] || ops_die "ALLOW_DIRTY_SOURCE must be NO or YES"

mkdir -p "$RELEASES_DIR" "$BACKUP_DIR"
ops_acquire_release_lock "$RELEASE_LOCK"

source_commit="$(git -C "$SOURCE_DIR" rev-parse --verify HEAD 2>/dev/null)" || ops_die "SOURCE_DIR must be a Git checkout with a valid HEAD"
source_dirty="no"
if [[ -n "$(git -C "$SOURCE_DIR" status --porcelain --untracked-files=normal)" ]]; then
    source_dirty="yes"
    [[ "$ALLOW_DIRTY_SOURCE" == "YES" ]] || ops_die "Source checkout is dirty; review and commit it, or set ALLOW_DIRTY_SOURCE=YES for a controlled recovery deploy"
    ops_warn "Deploying a dirty source checkout under explicit ALLOW_DIRTY_SOURCE=YES override"
fi

ops_load_env_file "$PROD_ENV"

ops_force_production_topology
ops_assert_production_topology
export PUBLIC_BASE_URL="https://$DOMAIN"
export APR_CURRENT_LINK="$CURRENT_LINK"
export APR_API_APP_NAME="$API_APP_NAME"
export APR_WORKER_APP_NAME="$WORKER_APP_NAME"

for required_name in DATABASE_URL APR_ADMIN_EMAIL APR_ADMIN_PASSWORD_HASH APR_MASTER_API_KEY APR_INGEST_API_KEY APR_SESSION_SECRET APR_USER_ID_HMAC_SECRET APR_TRUSTED_PROXIES; do
    [[ -n "${!required_name:-}" ]] || ops_die "Missing required env value in $PROD_ENV: $required_name"
done
ops_validate_postgres_url "$DATABASE_URL"

(
    cd "$SOURCE_DIR"
    node --input-type=module -e '
      import { loadConfig, validateConfig } from "./apps/dashboard/src/config.mjs";
      validateConfig(loadConfig());
    '
)

if [[ -z "${RELEASE_ID:-}" ]]; then
    git_suffix="${source_commit:0:12}"
    RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$git_suffix"
fi
ops_validate_identifier "RELEASE_ID" "$RELEASE_ID"
release_path="$RELEASES_DIR/$RELEASE_ID"
[[ ! -e "$release_path" && ! -L "$release_path" ]] || ops_die "Release already exists: $release_path"

old_target="$(ops_resolve_link "$CURRENT_LINK" 2>/dev/null || true)"
if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
    ops_die "Current path exists but is not a symlink: $CURRENT_LINK"
fi
if [[ -n "$old_target" ]]; then
    old_target="$(ops_assert_release_path "$old_target" "$RELEASES_DIR")"
fi

switched=0
handle_failure() {
    local status="$1"
    local step="${2:-unknown}"
    trap - ERR
    set +e
    echo "ERROR: Deployment failed during $step; release=$RELEASE_ID" >&2
    if [[ -d "$release_path" ]]; then
        printf 'failed_at=%s step=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$step" > "$release_path/.deploy-failed"
    fi
    if (( switched == 1 )); then
        if [[ -n "$old_target" && -d "$old_target" ]]; then
            echo "Restoring previous release: $old_target" >&2
            ops_atomic_symlink "$old_target" "$CURRENT_LINK"
            (ops_reload_pm2_stack "$CURRENT_LINK" "$API_APP_NAME" "$WORKER_APP_NAME") >/dev/null 2>&1 || ops_warn "PM2 reload of previous release failed"
            ops_check_platform "http://127.0.0.1:$PORT" "$ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_DELAY_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS" || ops_warn "Previous release acceptance did not pass"
            ops_check_pm2_stack_stable "$API_APP_NAME" "$WORKER_APP_NAME" "$PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_DELAY_SECONDS" "$PM2_MIN_UPTIME_MS" >/dev/null 2>&1 || ops_warn "Previous PM2 stack did not prove stable"
            pm2 save >/dev/null 2>&1 || true
        else
            rm -f -- "$CURRENT_LINK"
            pm2 stop "$API_APP_NAME" >/dev/null 2>&1 || true
            pm2 stop "$WORKER_APP_NAME" >/dev/null 2>&1 || true
            ops_warn "No previous release existed; current link was removed"
        fi
    fi
    exit "$status"
}
trap 'handle_failure "$?" "line-$LINENO"' ERR

echo "[1/7] Preparing immutable release $RELEASE_ID"
mkdir -p "$release_path"
rsync -a --delete \
    --exclude '.git' \
    --exclude '.tmp' \
    --exclude 'node_modules' \
    --exclude 'apps/dashboard/node_modules' \
    --exclude 'apps/dashboard/data/*.json' \
    --include '.env.example' \
    --exclude '.env*' \
    "$SOURCE_DIR/" "$release_path/"
rm -f -- "$release_path/.release-ready" "$release_path/.deploy-failed"
printf 'release_id=%s\ngit_commit=%s\nsource_dirty=%s\ndirty_override=%s\n' \
    "$RELEASE_ID" "$source_commit" "$source_dirty" "$ALLOW_DIRTY_SOURCE" > "$release_path/.release-source"

echo "[2/7] Installing production dependencies"
(cd "$release_path/standard" && npm ci --omit=dev)
(cd "$release_path/apps/dashboard" && npm ci --omit=dev)

echo "[3/7] Creating and verifying pre-deploy backup"
DATABASE_URL="$DATABASE_URL" \
BACKUP_DIR="$BACKUP_DIR" \
BACKUP_RETENTION_DAYS="$BACKUP_RETENTION_DAYS" \
BACKUP_LABEL="predeploy-$RELEASE_ID" \
bash "$release_path/scripts/ops/backup-postgres.sh"

echo "[4/7] Applying backward-compatible migrations"
(cd "$release_path/apps/dashboard" && npm run migrate)
printf 'prepared_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$release_path/.release-ready"

echo "[5/7] Switching current release atomically"
ops_atomic_symlink "$release_path" "$CURRENT_LINK"
switched=1

echo "[6/7] Reloading the PM2 API and worker stack without deleting processes"
if ! (ops_reload_pm2_stack "$CURRENT_LINK" "$API_APP_NAME" "$WORKER_APP_NAME"); then
    handle_failure 1 "PM2 stack reload"
fi

echo "[7/7] Verifying platform liveness, readiness, and PM2 stability"
if ! (ops_check_platform "http://127.0.0.1:$PORT" "$ACCEPTANCE_ATTEMPTS" "$ACCEPTANCE_DELAY_SECONDS" "$ACCEPTANCE_TIMEOUT_SECONDS"); then
    handle_failure 1 "HTTP acceptance"
fi
if ! (ops_check_pm2_stack_stable "$API_APP_NAME" "$WORKER_APP_NAME" "$PM2_STABILITY_ATTEMPTS" "$PM2_STABILITY_DELAY_SECONDS" "$PM2_MIN_UPTIME_MS"); then
    handle_failure 1 "PM2 stability acceptance"
fi
if ! pm2 save; then
    handle_failure 1 "PM2 state save"
fi

if [[ -n "$old_target" && -d "$old_target" ]]; then
    ops_atomic_symlink "$old_target" "$PREVIOUS_LINK"
fi
rm -f -- "$release_path/.deploy-failed"
trap - ERR

if ! PROD_DIR="$PROD_DIR" RELEASES_DIR="$RELEASES_DIR" CURRENT_LINK="$CURRENT_LINK" PREVIOUS_LINK="$PREVIOUS_LINK" KEEP_RELEASES="$KEEP_RELEASES" bash "$release_path/scripts/ops/prune-releases.sh"; then
    ops_warn "Release retention failed; deployment remains active"
fi

echo "Deployment completed: $CURRENT_LINK -> $release_path"
echo "Dashboard: https://$DOMAIN"
