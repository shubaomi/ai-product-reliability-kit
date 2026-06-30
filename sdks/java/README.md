# Java SDK

This is a dependency-free Java 11+ client for the stage 2 ingestion protocol.

The current local machine does not have a working `javac`, so the repository verifies this SDK with static checks in the root test audit. Compile it in a Java 11+ environment with:

```bash
javac sdks/java/src/main/java/com/aiproductreliability/ReliabilityClient.java
```

Minimal usage:

```java
ReliabilityClient client = new ReliabilityClient(
    "invoice-ai",
    "production",
    "git:abc1234",
    "https://reliability.example.com",
    System.getenv("APR_INGEST_API_KEY")
);

client.event("invoice_created", Map.of("plan", "pro"));
client.health(Map.of("database", true));
client.flush();
```
