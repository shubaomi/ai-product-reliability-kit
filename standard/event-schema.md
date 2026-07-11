# Product Event Standard v1

Events should prove a user or business outcome, not mirror internal implementation noise.

```json
{
  "schema_version": "1.0",
  "type": "event",
  "product_id": "invoice-ai",
  "environment": "production",
  "release": "git:abc1234",
  "occurred_at": "2026-07-10T12:00:00Z",
  "request_id": "req_789",
  "idempotency_key": "stable-item-id",
  "payload": {
    "event": "invoice_created",
    "properties": { "plan": "pro" }
  }
}
```

Use stable lowercase snake case and past-tense completed outcomes such as `checkout_succeeded`. A high-risk journey should declare a stable success event and, where practical, a paired failure event. Do not rename an existing event to change its meaning; add a new versioned event.

Useful safe context includes release, environment, request ID, and coarse non-sensitive dimensions. User/anonymous IDs are optional and HMAC-transformed by the collector. Never put credentials, raw prompts, private documents, payment data, or unbounded content in properties.

Assign a stable `idempotency_key` once and preserve it across retries. Deduplication is scoped by `product_id + environment + idempotency_key`, so the same key may independently describe a Staging and Production event. A replay in the same scope returns no new accepted record; it is not evidence that the event ran twice.

Event evidence may support journey freshness/drop alerts and retained daily aggregates. This V1 does not claim a full analytics, conversion-funnel, active-user, or release-comparison BI system.
