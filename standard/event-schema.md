# Event Schema v1

Use events to detect silent product failure. Events should describe user journeys and business outcomes, not internal implementation noise.

## Event Envelope

```json
{
  "schema_version": "1.0",
  "product_id": "invoice-ai",
  "environment": "production",
  "release": "git:abc1234",
  "event": "invoice_created",
  "occurred_at": "2026-06-30T12:00:00Z",
  "anonymous_id": "session_123",
  "user_id": "user_456",
  "request_id": "req_789",
  "properties": {
    "plan": "pro"
  }
}
```

## Required Fields

- `schema_version`
- `product_id`
- `environment`
- `release`
- `event`
- `occurred_at`

Use `anonymous_id` when user identity is unavailable or should not be sent. Avoid sending secrets, raw prompts, payment card data, private documents, or sensitive personal data.

## Naming Rules

- Use lowercase snake case: `user_signed_up`, `checkout_succeeded`.
- Use past tense for completed outcomes.
- Use a paired failure event for high-risk flows: `checkout_failed`, `ai_generation_failed`.
- Keep event names stable. Add new events instead of changing old meanings.

## Recommended Core Events

| Area | Success Event | Failure Event |
| --- | --- | --- |
| Account | `user_signed_up` | `signup_failed` |
| Login | `user_logged_in` | `login_failed` |
| Activation | `user_activated` | `activation_failed` |
| Payment | `checkout_succeeded` | `checkout_failed` |
| Subscription | `subscription_started` | `subscription_failed` |
| AI task | `ai_generation_succeeded` | `ai_generation_failed` |
| Export | `export_completed` | `export_failed` |

## Dashboard Aggregates

The central dashboard should aggregate:

- Event counts by product, environment, release, and day.
- Conversion rate for declared critical journeys.
- Failure rate by event pair.
- Active users by anonymous or user ID.
- Release comparison before and after deployment.

