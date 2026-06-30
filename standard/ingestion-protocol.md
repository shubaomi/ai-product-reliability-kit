# Ingestion Protocol v1

The ingestion protocol lets any product send operational data to a central dashboard without depending on a specific programming language or framework.

## Endpoint

Default local collector endpoint:

```text
POST /api/ingest
Authorization: Bearer <ingest-api-key>
```

SDKs may also post to specific endpoints:

```text
POST /api/products
POST /api/events
POST /api/errors
POST /api/health
POST /api/releases
```

## Envelope

```json
{
  "schema_version": "1.0",
  "type": "event",
  "product_id": "invoice-ai",
  "environment": "production",
  "release": "git:abc1234",
  "occurred_at": "2026-06-30T12:00:00Z",
  "anonymous_id": "session_123",
  "user_id": "user_456",
  "request_id": "req_789",
  "payload": {
    "event": "invoice_created",
    "properties": {
      "plan": "pro"
    }
  }
}
```

## Types

| Type | Payload |
| --- | --- |
| `product` | Product contract or product summary. |
| `event` | Core journey event with stable event name. |
| `error` | Error name, message, stack if safe, and context. |
| `health` | Liveness/readiness result and dependency checks. |
| `release` | Deployment version, timestamp, and notes. |

Required payload fields:

- `event`: `payload.event`
- `error`: `payload.name`, `payload.message`
- `health`: `payload.ok`
- `release`: `payload.version`

## Compatibility

- `schema_version: "1.0"` is stable for stage 2-4.
- Add optional fields instead of changing field meanings.
- Collectors must ignore unknown fields.
- SDKs must not send secrets, payment card data, raw private documents, or credentials.
