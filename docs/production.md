# Production Deployment

This guide runs the dashboard as a single-tenant production service with Postgres persistence, API key authentication, scheduled monitors, alert delivery, public status pages, and AI incident packages.

## 1. Prepare Secrets

Copy the example environment file:

```bash
cp .env.example .env
```

Generate random values for `POSTGRES_PASSWORD`, `APR_MASTER_API_KEY`, `APR_INGEST_API_KEY`, and `APR_SESSION_SECRET`:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Generate the admin password hash:

```bash
npm --prefix apps/dashboard run hash-password -- "replace-with-a-strong-password"
```

Put the hash into `APR_ADMIN_PASSWORD_HASH` in `.env`. Keep the plain password outside the repository.

## 2. Start The Platform

```bash
docker compose up -d --build
```

The dashboard service applies `apps/dashboard/db/migrations/001_initial.sql` on startup. For manual migration runs:

```bash
docker compose run --rm dashboard npm run migrate
```

Open the dashboard at `PUBLIC_BASE_URL` or `http://localhost:8787` and sign in with `APR_ADMIN_EMAIL` plus the password used to create `APR_ADMIN_PASSWORD_HASH`.

## 3. Register Products

Use the master key for admin operations:

```bash
node cli/src/index.mjs push examples/node-nextjs --dashboard-url http://localhost:8787 --api-key replace-with-master-key
node cli/src/index.mjs automate examples/node-nextjs --dashboard-url http://localhost:8787 --api-key replace-with-master-key --register-dashboard
```

Use the ingest key in product SDKs:

```js
const client = createReliabilityClient({
  productId: "invoice-ai",
  environment: "production",
  release: process.env.GIT_SHA,
  endpoint: "https://reliability.example.com",
  apiKey: process.env.APR_INGEST_API_KEY
});
```

## 4. Operate

- Dashboard: `/`
- Public fleet status: `/status`
- Public product status: `/status/<product-id>`
- Machine-readable public status: `/api/status`
- AI incident package JSON: `/api/incident-packages/<product-id>`
- AI incident package Markdown: `/api/incident-packages/<product-id>?format=md`
- Force one scheduler pass: `POST /api/scheduler/run-once` with the master key.

Configure `APR_ALERT_WEBHOOK_URL` or `APR_ALERT_FEISHU_WEBHOOK_URL` to forward alert deliveries. Monitor runs and alert deliveries are stored in Postgres for later diagnosis.

## 5. Upgrade Policy

The ingestion protocol stays compatible within schema version `1.0`: add optional fields, do not rename existing fields, and keep collectors tolerant of unknown fields. When the platform standard changes, run the CLI scan against connected products first, review the adoption plan, then apply changes product by product.
