# Automation

Stage 4 generates local, provider-neutral operations artifacts from a product contract.

```bash
node automation/src/index.mjs generate examples/node-nextjs --out .tmp/automation-example
```

Register generated monitors, alerts, and the status page with a running dashboard:

```bash
node cli/src/index.mjs automate examples/node-nextjs --out .tmp/automation-example --register-dashboard
```

For a production dashboard with auth enabled:

```bash
node cli/src/index.mjs automate examples/node-nextjs --dashboard-url https://reliability.hihongrun.com --api-key replace-with-master-key --register-dashboard
```

Generated files:

- `monitors.json` - HTTP, event freshness, and collector monitor definitions.
- `alerts.json` - health, error spike, and critical journey drop rules.
- `status-page.md` - status page starter content.
- `ai-incident-package.md` - evidence checklist and AI debugging prompt.

These files are intentionally provider-neutral. Later provider adapters can translate them into Better Stack, Uptime Kuma, Grafana, Sentry, or other systems.

When registered with the dashboard, monitor runs and alert deliveries are persisted. Public status page content is available at `/status/<product-id>`, and live AI incident packages are available at `/api/incident-packages/<product-id>?format=md`.
