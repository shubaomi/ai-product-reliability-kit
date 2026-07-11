# Server SDKs

Node.js, Python, and Java are production targets because active local projects use all three. Each client implements the same v1.x envelope and resilience contract without requiring application code to block or crash when the reliability collector is unavailable.

These are **server-side SDKs**. Do not ship an ingest/read key in a browser, mobile app, desktop binary, or mini program. Untrusted clients should call their own authenticated backend, which performs privacy filtering and emits the reliability envelope.

## Shared Behavior

- Required client identity: `product_id`, `environment`, and `release`.
- Default protocol version: `1.0`; compatible `1.x` minors are supported.
- Every SDK-generated item has a stable `idempotency_key` and retry sends the exact same serialized batch.
- The collector deduplicates all telemetry types by `product_id + environment + idempotency_key`; the same caller key may be used independently in different environments.
- Queue default: 1,000 items. On overflow the oldest item is dropped and the drop counter increases.
- Request timeout default: 2 seconds.
- Retry default: 3 retries with exponential backoff, cap, and jitter.
- A final failure is requeued at the front, bounded by the queue limit.
- `fail_open` is true by default: flush returns a structured failure result rather than breaking product work. Disable it only when the caller deliberately owns the exception path.
- `close`/shutdown stops new enqueue operations and attempts a bounded final flush (default 5 seconds).
- API keys are sent only in `Authorization: Bearer ...`; they are never included in telemetry payloads.

Create a product-scoped ingest key through Dashboard onboarding or the admin key API, then store its reveal-once value in that product's server-side secret manager under an application-owned name such as `APR_PRODUCT_API_KEY`. This name is used by the examples; it is not a shared platform setting. Do not use the platform-wide `APR_INGEST_API_KEY` as the normal credential for product SDKs.

The queue is intentionally process memory, not a durable event log. Applications that require guaranteed delivery should use an existing durable job/message system in front of the SDK rather than treating this small client as a broker.

## Node.js

Install from this checkout or pack it for an internal registry:

```bash
npm install ./sdks/node
```

```js
import { createReliabilityClient } from "@ai-product-reliability/sdk-node";

const client = createReliabilityClient({
  productId: "invoice-ai",
  environment: "production",
  release: process.env.GIT_SHA,
  endpoint: "https://reliability.hihongrun.com",
  apiKey: process.env.APR_PRODUCT_API_KEY,
  timeoutMs: 2_000,
  maxRetries: 3,
  maxQueueSize: 1_000,
  failOpen: true
});

client.event("invoice_created", { plan: "pro" }, { requestId: "req_123" });
client.health({ database: true, ai_api: true });
const result = await client.flush();

process.once("SIGTERM", async () => {
  await client.close({ timeoutMs: 5_000 });
  process.exit(0);
});
```

`queued()` returns a defensive copy; `dropped()` and `stats()` expose queue health.

## Python

```bash
python -m pip install ./sdks/python
```

```python
import os
from ai_product_reliability import ReliabilityClient

client = ReliabilityClient(
    product_id="invoice-ai",
    environment="production",
    release=os.environ["GIT_SHA"],
    endpoint="https://reliability.hihongrun.com",
    api_key=os.environ["APR_PRODUCT_API_KEY"],
    timeout_seconds=2.0,
    max_retries=3,
    max_queue_size=1000,
    fail_open=True,
)

client.event("invoice_created", {"plan": "pro"}, request_id="req_123")
client.health({"database": True, "ai_api": True})
result = client.flush()
client.close(timeout_seconds=5.0)
```

The client is thread-safe around queue mutations and can also be used as a context manager.

## Java

Java requires 17+. The Maven artifact is dependency-free at runtime:

```bash
mvn -f sdks/java/pom.xml verify
mvn -f sdks/java/pom.xml install
```

```java
import com.aiproductreliability.ReliabilityClient;
import java.util.Map;

ReliabilityClient.Options options = new ReliabilityClient.Options()
    .timeoutMillis(2_000)
    .maxRetries(3)
    .maxQueueSize(1_000)
    .failOpen(true);

try (ReliabilityClient client = new ReliabilityClient(
    "invoice-ai",
    "production",
    System.getenv("GIT_SHA"),
    "https://reliability.hihongrun.com",
    System.getenv("APR_PRODUCT_API_KEY"),
    options
)) {
    client.event("invoice_created", Map.of("plan", "pro"));
    client.health(Map.of("database", true, "ai_api", true));
    client.flush();
}
```

Java `Context` supports occurrence time, anonymous/user/request IDs, and a caller-provided idempotency key. `dropped()`, `queued()`, and `isClosed()` expose client state.

## Supported Envelope Types

- `event(name, properties)` — declared product/journey outcome.
- `error(error, context/properties)` — name/message and optional safe stack/context.
- `health(checks)` — overall `ok` plus named checks.
- `release` / `release_event` — deployed version and properties.
- `product(contract)` — product contract signal where supported.

See [../standard/ingestion-protocol.md](../standard/ingestion-protocol.md) for validation, privacy, compatibility, and batching rules.
