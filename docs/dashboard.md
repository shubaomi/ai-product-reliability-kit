# Dashboard

Stage 3 provides a local central dashboard for product health, events, errors, releases, monitors, and alerts.

Start it:

```bash
npm run dashboard
```

Open:

```text
http://127.0.0.1:8787
```

Register the example product and scan result:

```bash
node cli/src/index.mjs push examples/node-nextjs --dashboard-url http://127.0.0.1:8787
```

Useful APIs:

```text
GET  /api/summary
GET  /api/products
GET  /api/events
GET  /api/errors
GET  /api/health
GET  /api/status
POST /api/products
POST /api/ingest
POST /api/monitors
POST /api/alerts
POST /api/status-pages
```

The current storage backend is a local JSON file at `apps/dashboard/data/store.json`. This keeps stage 3 easy to run locally and easy to replace later with SQLite/Postgres.

