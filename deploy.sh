#!/bin/bash
# AI Product Reliability Kit deployment script
# Usage: ./deploy.sh

set -euo pipefail

echo "========== AI Product Reliability Kit deployment started =========="

SOURCE_DIR="/data/claude_project/ai-product-reliability-kit"
PROD_DIR="/data/prod/ai-product-reliability-kit"
APP_NAME="ai-product-reliability-kit"
DOMAIN="${APR_PUBLIC_DOMAIN:-reliability.hihongrun.com}"
PORT="${PORT:-8787}"
PROD_ENV="$PROD_DIR/.env.production"

echo "[1/7] Entering source directory..."
cd "$SOURCE_DIR"

echo "[2/7] Preparing production environment..."
mkdir -p "$PROD_DIR"

if [ -f "$SOURCE_DIR/.env.local" ] || [ -f "$SOURCE_DIR/.env" ]; then
    echo "ERROR: Local env files must not exist in the production source directory."
    echo "Move them away before deploying, for example:"
    echo "  mv $SOURCE_DIR/.env $SOURCE_DIR/.env.bak"
    echo "  mv $SOURCE_DIR/.env.local $SOURCE_DIR/.env.local.bak"
    exit 1
fi

if [ ! -f "$PROD_ENV" ]; then
    if [ -f "$SOURCE_DIR/.env.production" ]; then
        cp "$SOURCE_DIR/.env.production" "$PROD_ENV"
        echo "  Copied initial .env.production to production directory"
    else
        echo "ERROR: Missing production env file: $PROD_ENV"
        echo "Create it from .env.example and fill production secrets first."
        exit 1
    fi
fi

set -a
. "$PROD_ENV"
set +a

DOMAIN="${APR_PUBLIC_DOMAIN:-$DOMAIN}"
export NODE_ENV="${NODE_ENV:-production}"
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8787}"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://$DOMAIN}"
export APR_STORE_MODE="${APR_STORE_MODE:-postgres}"
export APR_AUTH_REQUIRED="${APR_AUTH_REQUIRED:-true}"
export APR_WORKER_ENABLED="${APR_WORKER_ENABLED:-true}"
export APR_WORKER_INTERVAL_MS="${APR_WORKER_INTERVAL_MS:-60000}"

for required in DATABASE_URL APR_ADMIN_EMAIL APR_ADMIN_PASSWORD_HASH APR_MASTER_API_KEY APR_INGEST_API_KEY APR_SESSION_SECRET; do
    if [ -z "${!required:-}" ]; then
        echo "ERROR: Missing required env value in $PROD_ENV: $required"
        exit 1
    fi
done

echo "[3/7] Syncing source to production directory..."
if ! command -v rsync >/dev/null 2>&1; then
    echo "ERROR: rsync is required for deployment."
    exit 1
fi

rsync -a --delete \
    --exclude ".git" \
    --exclude ".tmp" \
    --exclude "node_modules" \
    --exclude "apps/dashboard/node_modules" \
    --exclude "apps/dashboard/data/*.json" \
    --exclude ".env" \
    --exclude ".env.*" \
    "$SOURCE_DIR/" "$PROD_DIR/"

echo "[4/7] Installing dashboard dependencies..."
cd "$PROD_DIR/apps/dashboard"
npm ci --omit=dev

echo "[5/7] Applying database migrations..."
npm run migrate

echo "[6/7] Restarting PM2..."
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start "$PROD_DIR/apps/dashboard/server.mjs" --name "$APP_NAME" --update-env
pm2 save

echo "[7/7] Verifying local health endpoint..."
for attempt in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then
        echo "  Health check passed"
        break
    fi
    if [ "$attempt" -eq 30 ]; then
        echo "ERROR: Health check failed after 30 attempts."
        echo "Inspect logs with: pm2 logs $APP_NAME"
        exit 1
    fi
    sleep 1
done

echo ""
echo "========== AI Product Reliability Kit deployment completed =========="
echo "Visit: https://$DOMAIN"
echo ""
echo "Useful commands:"
echo "  pm2 status"
echo "  pm2 logs $APP_NAME"
echo "  pm2 restart $APP_NAME --update-env"
echo "  cd $PROD_DIR/apps/dashboard && npm run migrate"
echo ""
echo "Tip: run git pull origin main first if you need the latest code."
