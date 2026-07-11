# Dashboard and API

The Dashboard is an operations service, not an analytics homepage. Its first view prioritizes current outages/degradation, active incidents, deduplicated alerts, and explicit coverage gaps. Cumulative telemetry counts are supporting evidence only.

## Local Mode

```bash
npm ci --prefix apps/dashboard
npm run dashboard
```

Open `http://127.0.0.1:8787`. By default, local mode uses atomic JSON storage at `apps/dashboard/data/store.json`, does not require auth, and does not enable the scheduler. Override `APR_DASHBOARD_STORE` for an isolated store file.

For a deterministic local PostgreSQL integration environment, Docker Compose is available. It runs in development mode with an embedded worker and is not the supported production topology.

## Operator UI

- **Operations desk** — fleet four-state summary, current action queue, explicit unknown/coverage gaps, and production-first environment cards.
- **Products** — search by name, ID, or owner and open one environment without cross-environment aggregation.
- **Onboarding** — import or manually build a complete contract, validate it server-side, create/copy a reveal-once ingest-only key, use Node/Python/Java snippets, prove keyed connectivity, and configure the first SSRF-validated monitor.
- **Product detail** — state reasons, environment selector, releases, monitor configuration/runs, critical journeys, ranged errors/events, alerts, incidents, maintenance, key lifecycle, and publication control.
- **Incidents** — open, acknowledge, assign, select/link active alerts, resolve with a mandatory recovery note, and retain the timeline.
- **System Passport** — dynamic product/contract/scan/runtime entries, each labelled with source, timestamp, and declared/detected/verified/unverified/stale provenance.
- **Public status** — explicit Production-only projection using the same state model and an output allowlist.

The Playwright suite exercises login, YAML and manual onboarding, keyed connectivity, product signals, alert linking and incident recovery, passport provenance, public redaction, loading/error states, and long-content layout bounds on desktop Chromium and a Pixel 7 profile. Whether that suite has passed for the current revision belongs in the readiness report; configured coverage alone is not a pass result.

## Onboarding Trust Boundary

Onboarding establishes one product boundary in this order:

1. **Contract:** import `product.yml` text or use the manual form. Manual mode builds the required identity, environment, critical journey, health paths, release source/rollback path, and explicit publication decision.
2. **Validation:** `POST /api/product-contracts/validate` uses the same strict YAML parser, JSON Schema, v1.x compatibility rules, warnings, and migration advice as the CLI. Invalid or edited YAML cannot be registered until it is revalidated.
3. **Credential:** registration creates a product-scoped key with `ingest` only. Its `apr_pk_...` value is returned once; only its hash is retained. Later admin key creation may deliberately add product-scoped `read` access.
4. **Connection proof:** the Node, Python, and Java snippets read the reveal-once secret from the product application's server-side `APR_PRODUCT_API_KEY`. The Dashboard writes a test event with that key, then uses the operator session—not the ingest key—to confirm the same idempotency key through product detail. The first-monitor step remains locked until this round trip succeeds.
5. **Independent evidence:** save the first environment-scoped monitor. State remains `unknown` until trustworthy health and required monitor evidence arrives.

`public_status.enabled` is a schema-validated boolean and defaults to private when omitted. No product is added to Public Status merely because it was registered.

## Authentication and Keys

Browser login uses `APR_ADMIN_EMAIL` and a PBKDF2-SHA256 hash generated with:

```bash
npm --prefix apps/dashboard run hash-password -- "choose-a-strong-password"
```

Production machine access supports:

- `APR_MASTER_API_KEY` — admin/read/ingest.
- `APR_INGEST_API_KEY` — global ingest boundary for controlled migration/operations.
- Product keys — reveal-once records scoped to one product and `ingest`, `read`, or both.

Product SDKs should use their own reveal-once ingest key, stored by the product server under an application-owned secret name such as `APR_PRODUCT_API_KEY`; they should not use the global ingest credential. Product keys can be listed without their hash, rotated, revoked, expired, and have `last_used_at` updated. A valid key for product A receives 403 when the envelope targets product B; a product envelope whose nested contract identifies a different product is rejected as malformed with 400. Never embed these keys in browser, mobile, desktop, or mini-program binaries.

## API Scope Matrix

| Required boundary | Routes | Behavior |
| --- | --- | --- |
| Public | `GET /healthz`, `/readyz`, `/api/status`, `/status`, `/status/:slug`; `POST /api/session/login` | Liveness/readiness and the allowlisted, opt-in public projection only. |
| `read` | `GET /api/products`, `/api/products/:id/detail`, `/api/operational-status`, `/api/events`, `/api/errors`, `/api/health`, `/api/incidents`, `/api/alert-instances`, `/api/maintenance-windows`, `/api/compliance-scans`, `/api/system-passports/:id`, `/api/incident-packages/:id` | A product key is forced to its own `product_id` even when the query omits or changes it. |
| `ingest` | `POST /api/ingest`, `/api/compliance-scans` | A product key may write only its own product; the global ingest key has no read/admin access. Compliance scans remain separate from runtime health. |
| `admin` | `GET /api/summary`, `/api/audit-logs`, `/api/products/:id/api-keys`; `POST /api/product-contracts/validate`, `/api/products`, key create/rotate/revoke, `/api/monitors`, `/api/alerts`, `/api/status-pages`, incident lifecycle/package routes, `/api/alert-instances/:id/acknowledge`, `/api/maintenance-windows`, `/api/retention/run`, `/api/scheduler/run-once` | Browser admin sessions and the master key own fleet mutation and sensitive records. |

The detailed parameterized routes are:

```text
GET  /api/products/:id/detail?environment=production
GET  /api/operational-status?product_id=&environment=
GET  /api/system-passports/:product_id?environment=
GET  /api/incident-packages/:product_id[?format=md]
POST /api/products/:product_id/api-keys/:key_id/{rotate,revoke}
POST /api/incidents/:id/{acknowledge,assign,link-alerts,resolve,reopen}
```

`POST /api/ingest` accepts one envelope or `{ "items": [...] }`. Its success response includes `accepted`, `warnings`, and `migration_advice`; an idempotent replay can therefore return `accepted: 0` without being an error. Malformed JSON is 400, an oversized body is 413, exceeded rate limits are 429, ownership collisions are 409, and unauthorized product scope is 403. Compatibility failures include a stable error `code` and details. Error responses do not expose stack traces.

## Audit Records

Admin-only `GET /api/audit-logs` exposes bounded records for login attempts and sensitive mutations: product/compliance changes, monitor/alert/status-page registration, product-key lifecycle, incident lifecycle/packages, maintenance, alert acknowledgement, scheduler runs, and retention runs. Actor identifiers are HMAC transformed where applicable, metadata is restricted to explicitly selected non-secret fields, and request bodies, plaintext keys, authorization headers, cookies, and webhook secrets are not copied into the audit record.

## API and Worker Separation

Production PM2 configuration sets:

| Process | Entry point | Role |
| --- | --- | --- |
| `ai-product-reliability-kit` | `apps/dashboard/server.mjs` | API only, `APR_PROCESS_ROLE=api`, no embedded worker |
| `ai-product-reliability-worker` | `apps/dashboard/worker.mjs` | scheduler + retention, `APR_PROCESS_ROLE=worker` |

The Worker executes only due monitor intervals, respects maintenance windows and timeouts, revalidates URLs before fetch, and acquires a PostgreSQL advisory lease around each scheduling/retention pass. This provides a second safety layer if PM2 briefly overlaps worker processes during reload.

## PostgreSQL and Migrations

Set `DATABASE_URL` and `APR_STORE_MODE=postgres`. Apply migrations explicitly before process reload:

```bash
npm --prefix apps/dashboard run migrate
```

The runner obtains a migration advisory lock, validates checksums, records `schema_migrations`, and wraps each new migration in its own transaction. The current sequence is `001_initial`, `002_phase2_foundations`, `003_runtime_operations`, and `004_integrity_and_upgrade_safety`.

Migration 004 adds the `product_id + environment + idempotency_key` ledger for all telemetry types, preserves legacy event uniqueness through a compatibility trigger, backfills alert-instance rule types, archives duplicate legacy status pages, and adds retention indexes. Migration 003 deliberately disables migrated free-form legacy alerts and writes `config.migration_advice`; recreate and review those rules as one of the four structured environment-scoped types rather than toggling the legacy row on. Startup readiness reports whether the store and migrations are usable; `/healthz` alone is not sufficient deployment acceptance.

See [production.md](production.md) for the strict environment contract and [runbook.md](runbook.md) for operations.
