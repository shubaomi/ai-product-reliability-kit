#!/usr/bin/env bash

ops_die() {
    echo "ERROR: $*" >&2
    exit 1
}

ops_warn() {
    echo "WARNING: $*" >&2
}

ops_require_command() {
    command -v "$1" >/dev/null 2>&1 || ops_die "Required command not found: $1"
}

ops_require_positive_integer() {
    local name="$1"
    local value="$2"
    [[ "$value" =~ ^[1-9][0-9]*$ ]] || ops_die "$name must be a positive integer"
}

ops_acquire_release_lock() {
    local lock_path="$1"
    local lock_parent
    lock_parent="$(dirname "$lock_path")"
    mkdir -p "$lock_parent"
    exec {OPS_RELEASE_LOCK_FD}>"$lock_path"
    flock -n "$OPS_RELEASE_LOCK_FD" || ops_die "Another deploy or rollback operation holds the release lock: $lock_path"
}

ops_force_production_topology() {
    export NODE_ENV="production"
    export HOST="127.0.0.1"
    export PORT="8787"
    export APR_STORE_MODE="postgres"
    export APR_AUTH_REQUIRED="true"
}

ops_assert_production_topology() {
    [[ "${NODE_ENV:-}" == "production" ]] || ops_die "NODE_ENV must be production"
    [[ "${HOST:-}" == "127.0.0.1" ]] || ops_die "HOST must be 127.0.0.1"
    [[ "${PORT:-}" == "8787" ]] || ops_die "PORT must be 8787"
    [[ "${APR_STORE_MODE:-}" == "postgres" ]] || ops_die "APR_STORE_MODE must be postgres"
    [[ "${APR_AUTH_REQUIRED:-}" == "true" ]] || ops_die "APR_AUTH_REQUIRED must be true"
}

ops_validate_identifier() {
    local name="$1"
    local value="$2"
    [[ "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || ops_die "$name contains unsafe characters"
}

ops_validate_postgres_url() {
    local value="$1"
    [[ "$value" == postgres://* || "$value" == postgresql://* ]] || ops_die "A postgres:// or postgresql:// URL is required"
    [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || ops_die "Postgres URL contains a newline"
}

ops_load_env_file() {
    local env_file="$1"
    local mode
    [[ -f "$env_file" ]] || ops_die "Missing production environment file: $env_file"
    [[ ! -L "$env_file" ]] || ops_die "Production environment file must not be a symlink: $env_file"
    mode="$(stat -c '%a' "$env_file" 2>/dev/null || stat -f '%Lp' "$env_file" 2>/dev/null || true)"
    if [[ "$mode" =~ ^[0-7]{3,4}$ ]]; then
        (( (8#$mode & 077) == 0 )) || ops_die "Production environment file must not be group/world accessible: $env_file"
    fi
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
}

ops_atomic_symlink() {
    local target="$1"
    local link_path="$2"
    local parent
    local temp_link
    parent="$(dirname "$link_path")"
    temp_link="$parent/.${link_path##*/}.tmp.$$"
    mkdir -p "$parent"
    rm -f -- "$temp_link"
    ln -s "$target" "$temp_link"
    mv -Tf -- "$temp_link" "$link_path"
}

ops_resolve_link() {
    local link_path="$1"
    [[ -L "$link_path" ]] || return 1
    readlink -f -- "$link_path"
}

ops_assert_release_path() {
    local candidate="$1"
    local releases_dir="$2"
    local resolved_candidate
    local resolved_releases
    resolved_candidate="$(readlink -f -- "$candidate")" || ops_die "Release does not exist: $candidate"
    resolved_releases="$(readlink -f -- "$releases_dir")" || ops_die "Releases directory does not exist: $releases_dir"
    case "$resolved_candidate" in
        "$resolved_releases"/*) printf '%s\n' "$resolved_candidate" ;;
        *) ops_die "Release path escapes releases directory: $candidate" ;;
    esac
}

ops_assert_release_ready() {
    local release_path="$1"
    [[ ! -e "$release_path/.deploy-failed" ]] || ops_die "Target release is marked as failed: $release_path"
    [[ -f "$release_path/.release-ready" ]] || ops_die "Target release has no completed preparation marker: $release_path"
    [[ -f "$release_path/apps/dashboard/server.mjs" ]] || ops_die "Target release has no API entry point: $release_path"
    [[ -f "$release_path/apps/dashboard/worker.mjs" ]] || ops_die "Target release has no worker entry point: $release_path"
    [[ -f "$release_path/deploy/ecosystem.config.cjs" ]] || ops_die "Target release has no PM2 ecosystem file: $release_path"
}

ops_wait_for_url() {
    local url="$1"
    local attempts="$2"
    local delay_seconds="$3"
    local timeout_seconds="$4"
    local attempt
    ops_require_positive_integer "ACCEPTANCE_ATTEMPTS" "$attempts"
    [[ "$delay_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "ACCEPTANCE_DELAY_SECONDS must be non-negative"
    ops_require_positive_integer "ACCEPTANCE_TIMEOUT_SECONDS" "$timeout_seconds"
    for ((attempt = 1; attempt <= attempts; attempt += 1)); do
        if curl --fail --silent --show-error --max-time "$timeout_seconds" "$url" >/dev/null; then
            return 0
        fi
        if (( attempt < attempts )); then
            sleep "$delay_seconds"
        fi
    done
    return 1
}

ops_check_platform() {
    local base_url="$1"
    local attempts="$2"
    local delay_seconds="$3"
    local timeout_seconds="$4"
    ops_wait_for_url "$base_url/healthz" "$attempts" "$delay_seconds" "$timeout_seconds" || return 1
    ops_wait_for_url "$base_url/readyz" "$attempts" "$delay_seconds" "$timeout_seconds"
}

ops_check_pm2_stack_stable() {
    local api_name="$1"
    local worker_name="$2"
    local attempts="$3"
    local delay_seconds="$4"
    local min_uptime_ms="$5"
    local attempt

    ops_require_positive_integer "PM2_STABILITY_ATTEMPTS" "$attempts"
    [[ "$delay_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || ops_die "PM2_STABILITY_DELAY_SECONDS must be non-negative"
    ops_require_positive_integer "PM2_MIN_UPTIME_MS" "$min_uptime_ms"

    for ((attempt = 1; attempt <= attempts; attempt += 1)); do
        if pm2 jlist | APR_PM2_API_NAME="$api_name" APR_PM2_WORKER_NAME="$worker_name" APR_PM2_MIN_UPTIME_MS="$min_uptime_ms" node --input-type=module -e '
          try {
            let input = "";
            for await (const chunk of process.stdin) input += chunk;
            const processes = JSON.parse(input);
            const minimum = Number(process.env.APR_PM2_MIN_UPTIME_MS);
            const now = Date.now();
            for (const name of [process.env.APR_PM2_API_NAME, process.env.APR_PM2_WORKER_NAME]) {
              const matches = processes.filter((entry) => entry?.name === name);
              if (matches.length !== 1) throw new Error(`expected exactly one PM2 process named ${name}`);
              const environment = matches[0].pm2_env ?? {};
              const startedAt = Number(environment.pm_uptime);
              if (environment.status !== "online") throw new Error(`PM2 process ${name} is ${environment.status ?? "unknown"}`);
              if (!Number.isFinite(startedAt) || now - startedAt < minimum) {
                throw new Error(`PM2 process ${name} has not remained online for ${minimum}ms`);
              }
            }
          } catch (error) {
            console.error(`PM2 stability check failed: ${error.message}`);
            process.exit(1);
          }
        '; then
            return 0
        fi
        if (( attempt < attempts )); then
            sleep "$delay_seconds"
        fi
    done
    return 1
}

ops_reload_pm2_stack() {
    local current_link="$1"
    local api_name="$2"
    local worker_name="$3"
    local ecosystem_file="$current_link/deploy/ecosystem.config.cjs"

    export APR_CURRENT_LINK="$current_link"
    export APR_API_APP_NAME="$api_name"
    export APR_WORKER_APP_NAME="$worker_name"

    if [[ -f "$ecosystem_file" ]]; then
        if pm2 describe "$api_name" >/dev/null 2>&1 && pm2 describe "$worker_name" >/dev/null 2>&1; then
            pm2 reload "$ecosystem_file" --env production --update-env
        else
            pm2 startOrReload "$ecosystem_file" --env production --update-env
        fi
        pm2 describe "$api_name" >/dev/null 2>&1 || ops_die "PM2 API process is not registered: $api_name"
        pm2 describe "$worker_name" >/dev/null 2>&1 || ops_die "PM2 worker process is not registered: $worker_name"
        return
    fi

    # Compatibility path for a retained release created before API/worker split.
    [[ -f "$current_link/apps/dashboard/server.mjs" ]] || ops_die "Legacy release has no API entry point: $current_link"
    APR_PROCESS_ROLE=all APR_WORKER_ENABLED=true pm2 reload "$api_name" --update-env
    if pm2 describe "$worker_name" >/dev/null 2>&1; then
        pm2 stop "$worker_name"
    fi
}
