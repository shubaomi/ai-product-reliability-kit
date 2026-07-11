# Java SDK

Dependency-free Java 17+ server client for the AI Product Reliability v1.x ingestion protocol.

```bash
mvn verify
mvn install
```

The Maven contract starts a real local HTTP collector and verifies authenticated delivery, bounded queue/drop counting, exact-body retry with stable idempotency, failed-batch requeue, fail-open behavior, JSON arrays, close flush, and shared v1.0/v1.1/v1.9 fixtures.

```java
import com.aiproductreliability.ReliabilityClient;
import java.util.Map;

ReliabilityClient client = new ReliabilityClient(
    "invoice-ai",
    "production",
    "git:abc1234",
    "https://reliability.example.com",
    System.getenv("APR_PRODUCT_API_KEY"),
    new ReliabilityClient.Options().maxRetries(3).timeoutMillis(2_000)
);

client.event("invoice_created", Map.of("plan", "pro"));
client.health(Map.of("database", true));
client.flush();
client.close();
```

See `../../docs/sdk.md` for the cross-language resilience contract and client-side trust boundary.
