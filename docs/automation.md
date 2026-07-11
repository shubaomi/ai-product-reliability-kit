# Automation

Automation generates local, provider-neutral operations artifacts from a formally parsed product contract. It does not contact an external provider.

```bash
node automation/src/index.mjs generate examples/node-nextjs --out .tmp/automation-example
```

Register generated monitors, alerts, and the status page with a running dashboard:

```bash
node cli/src/index.mjs automate examples/node-nextjs --out .tmp/automation-example --register-dashboard
```

For a production dashboard with auth enabled:

```bash
node cli/src/index.mjs automate examples/node-nextjs --dashboard-url https://reliability.hihongrun.com --api-key "$APR_MASTER_API_KEY" --register-dashboard
```

Generated files:

- `monitors.json` - HTTP, event freshness, and collector monitor definitions.
- `alerts.json` - only the four supported structured rules: availability failure, telemetry stale, error spike, and critical journey drop.
- `status-page.md` - status page starter content.
- `ai-incident-package.md` - evidence checklist and AI debugging prompt.

These files are intentionally provider-neutral. Add a provider adapter only after a provider is selected and repeated manual translation proves the maintenance cost worthwhile.

Registration requires an admin session/master key because it mutates monitor, alert, and status-page configuration; a product ingest key is intentionally insufficient. The mutations produce bounded audit records without copying webhook secrets. Monitor runs, deduplicated alert instances, alert/recovery deliveries, and status-page configuration are persisted. Public status remains hidden unless the schema-validated product contract explicitly sets `public_status.enabled: true`. Live incident packages are available at `/api/incident-packages/<product-id>?format=md`.

If upgrading rows created by the old free-form `condition` shape, do not enable the migrated compatibility row. Migration 003 disables it, preserves the original condition, and attaches advice; regenerate or recreate a reviewed environment-scoped rule using one of the four structured types.
