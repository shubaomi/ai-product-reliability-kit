package com.aiproductreliability;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

final class ReliabilityClientContractTest {
    @Test
    void flushSendsVersionedAuthorizedEnvelope() throws Exception {
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> authorization = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/ingest", exchange -> {
            body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            authorization.set(exchange.getRequestHeaders().getFirst("authorization"));
            byte[] response = "{\"accepted\":2}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("content-type", "application/json");
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();

        try {
            ReliabilityClient client = new ReliabilityClient(
                "java-contract-product",
                "test",
                "contract-release",
                "http://127.0.0.1:" + server.getAddress().getPort(),
                "java-contract-key"
            );
            client.event("contract_completed", Map.of("source", "maven"));
            client.health(Map.of("database", true));
            assertEquals(2, client.queued());
            assertEquals("{\"accepted\":2}", client.flush());
            assertEquals(0, client.queued());
            assertEquals("Bearer java-contract-key", authorization.get());
            assertTrue(body.get().contains("\"schema_version\":\"1.0\""));
            assertTrue(body.get().contains("\"product_id\":\"java-contract-product\""));
            assertTrue(body.get().contains("\"environment\":\"test\""));
        } finally {
            server.stop(0);
        }
    }
}
