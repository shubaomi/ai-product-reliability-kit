# Ingestion Protocol v1.x

The ingestion protocol is a server-to-server boundary for product, event, error, health, and release evidence.

## Endpoint and Authentication

```text
POST /api/ingest
Content-Type: application/json
Authorization: Bearer <ingest-or-product-key>
```

The body is one envelope or `{ "items": [...] }`. Production accepts a configured ingest/master key or a reveal-once product key with `ingest` scope. Product applications should use their own product-scoped key, stored server-side under an application-owned secret name such as `APR_PRODUCT_API_KEY`; the platform-wide ingest key is for controlled migration/operations. A product key may send only its own `product_id`; cross-product input is 403.

## Envelope

```json
{
  "schema_version": "1.0",
  "type": "event",
  "product_id": "invoice-ai",
  "environment": "production",
  "release": "git:abc1234",
  "occurred_at": "2026-07-10T12:00:00Z",
  "anonymous_id": "session_123",
  "request_id": "req_789",
  "idempotency_key": "018f-stable-item-id",
  "payload": {
    "event": "invoice_created",
    "properties": { "plan": "pro" }
  }
}
```

Required collector fields are `schema_version`, `type`, `product_id`, `environment`, `release`, `occurred_at`, and object `payload`. Production SDKs also always emit `idempotency_key`; the collector still accepts older v1.0 envelopes without it for compatibility. When present, replay protection for product, event, error, health, and release envelopes is keyed by `product_id + environment + idempotency_key`.

Optional correlation fields are `anonymous_id`, `user_id`, and `request_id`. Unknown optional fields are tolerated within v1.x.

## Payload Types

| Type | Required payload | Purpose |
| --- | --- | --- |
| `product` | product contract/summary object | Registry signal |
| `event` | `event` string; optional `properties` | Critical journey/business outcome |
| `error` | `name`, `message`; optional safe stack/properties | Redacted failure evidence |
| `health` | boolean `ok`; optional named `checks` | Runtime/dependency state |
| `release` | `version`; optional properties/notes | Deployment identity |

## Validation and Privacy

The collector validates body/batch size, string lengths, nesting depth, product/environment/type, timestamp parse/age/skew, payload shape, and supported major version. Malformed JSON is 400; oversized input is 413.

Fields whose names indicate passwords, tokens, secrets, API keys, authorization, cookies, or payment-card data are redacted before storage. User and anonymous identifiers are transformed with a production HMAC secret. Clients should still minimize at source: do not send credentials, payment data, raw private documents, private prompts/responses, or unnecessary personal information.

## Compatibility

- Collector current version is v1.1 and supports compatible v1.x clients, including v1.0.
- An older minor remains accepted and the ingest response returns migration advice.
- A newer v1 minor remains accepted; unknown optional fields are ignored and the ingest response returns any compatibility warning.
- Deprecated `timestamp` is normalized to `occurred_at` with an ingest warning.
- Major v2 input receives an explicit unsupported-major error.

Shared fixtures in `standard/test/fixtures/protocol` are consumed by Standard, Node, Python, and Java contract tests.

## Delivery Semantics

Clients should assign one idempotency key per item, serialize a batch once, use a finite timeout, retry transient transport/408/425/429/5xx failures with capped exponential backoff and jitter, and requeue the exact failed batch. A bounded in-memory queue and drop counter are required so collector downtime cannot consume unbounded product memory. Do not intentionally reuse a key for two different items in the same product/environment.

The API returns `{ "accepted": number, "warnings": [], "migration_advice": [] }` on success. An idempotent replay may return `accepted: 0`. `fail_open` SDK behavior protects the product request path but does not guarantee delivery; use an existing durable job/message system when lossless delivery is a business requirement.
