# SDKs

Stage 2 provides a language-neutral ingestion protocol plus lightweight SDKs.

## Protocol

Read `standard/ingestion-protocol.md` and `standard/telemetry-envelope.schema.json`.

Default collector:

```text
POST http://127.0.0.1:8787/api/ingest
```

## Node.js

```js
import { createReliabilityClient } from "./sdks/node/src/index.mjs";

const client = createReliabilityClient({
  productId: "invoice-ai",
  environment: "production",
  release: process.env.GIT_SHA,
  endpoint: "http://127.0.0.1:8787"
});

client.event("invoice_created", { plan: "pro" });
client.health({ database: true, ai_api: true });
await client.flush();
```

## Python

```python
from ai_product_reliability import ReliabilityClient

client = ReliabilityClient(
    product_id="invoice-ai",
    environment="production",
    release="git:abc1234",
    endpoint="http://127.0.0.1:8787",
)

client.event("invoice_created", {"plan": "pro"})
client.health({"database": True, "ai_api": True})
client.flush()
```

## Java

The Java SDK is dependency-free Java 11+ source in `sdks/java`. The current local machine cannot run `javac`, so compile it in a Java 11+ environment.

## Safety

Do not send secrets, credentials, raw private documents, payment card data, or sensitive prompts.

