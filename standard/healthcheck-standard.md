# Health Check Standard v1

Health checks make products monitorable without understanding internal business code.

## Endpoints

### `/healthz`

Liveness check. It answers whether the process can receive requests.

Expected response:

```json
{
  "ok": true,
  "product_id": "invoice-ai",
  "environment": "production",
  "release": "git:abc1234",
  "time": "2026-06-30T12:00:00Z"
}
```

Use HTTP 200 when live. Use HTTP 500 when the process is unhealthy.

### `/readyz`

Readiness check. It answers whether required dependencies are usable.

Expected response:

```json
{
  "ok": true,
  "checks": {
    "database": true,
    "storage": true,
    "ai_api": true
  }
}
```

Use HTTP 200 when ready. Use HTTP 503 when a required dependency blocks normal traffic.

## Rules

- Keep checks fast. Prefer under 500 ms.
- Do not perform expensive business operations.
- Do not expose secrets, connection strings, stack traces, tokens, or private data.
- Include product ID, environment, release, and timestamp.
- Let `/healthz` stay shallow; put dependency checks in `/readyz`.

## Monitoring

At minimum, monitor:

- `/healthz` every 1-5 minutes.
- Critical public pages or APIs.
- The success rate of declared critical journey events.
- Release-specific error rate for the first hours after deployment.

