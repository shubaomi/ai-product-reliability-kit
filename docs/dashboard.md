# Dashboard

The dashboard is the central reliability operations service. It receives SDK telemetry, stores product health and events, runs monitors, records alert deliveries, exposes public status pages, and generates AI incident packages.

## Local Mode

```bash
npm run dashboard
```

Open:

```text
http://127.0.0.1:8787
```

Local mode defaults to JSON storage at `apps/dashboard/data/store.json` and does not require auth unless `APR_AUTH_REQUIRED=true`.

## Production Mode

Use Docker Compose and Postgres:

```bash
cp .env.example .env
docker compose up -d --build
```

Production mode sets:

- `APR_STORE_MODE=postgres`
- `APR_AUTH_REQUIRED=true`
- `APR_WORKER_ENABLED=true`
- `DATABASE_URL=postgres://...`

The server applies migrations on startup. You can also run `npm --prefix apps/dashboard run migrate` with `DATABASE_URL` set.

## Auth

Browser login uses `APR_ADMIN_EMAIL` plus the password represented by `APR_ADMIN_PASSWORD_HASH`.

Machine access uses:

- `APR_MASTER_API_KEY` for admin, read, and ingestion operations.
- `APR_INGEST_API_KEY` for product SDK ingestion.

CLI commands accept `--api-key <key>` or read `APR_API_KEY`.

## Useful APIs

```text
GET  /api/summary
GET  /api/products
GET  /api/events
GET  /api/errors
GET  /api/health
GET  /api/status
GET  /api/incident-packages/:product_id
POST /api/products
POST /api/ingest
POST /api/monitors
POST /api/alerts
POST /api/status-pages
POST /api/scheduler/run-once
POST /api/incident-packages/:product_id
```

Public routes:

```text
GET /status
GET /status/:product_id
GET /api/status
```
