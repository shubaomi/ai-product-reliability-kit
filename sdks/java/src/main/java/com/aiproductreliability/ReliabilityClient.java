package com.aiproductreliability;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.StringJoiner;

public final class ReliabilityClient {
    private final String productId;
    private final String environment;
    private final String release;
    private final String endpoint;
    private final String apiKey;
    private final HttpClient httpClient;
    private final List<String> queue = new ArrayList<>();

    public ReliabilityClient(String productId, String environment, String release, String endpoint) {
        this(productId, environment, release, endpoint, null);
    }

    public ReliabilityClient(String productId, String environment, String release, String endpoint, String apiKey) {
        if (productId == null || productId.isBlank()) throw new IllegalArgumentException("productId is required");
        if (environment == null || environment.isBlank()) throw new IllegalArgumentException("environment is required");
        if (release == null || release.isBlank()) throw new IllegalArgumentException("release is required");
        this.productId = productId;
        this.environment = environment;
        this.release = release;
        this.endpoint = trimTrailingSlash(endpoint == null || endpoint.isBlank() ? "http://127.0.0.1:8787" : endpoint);
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newHttpClient();
    }

    public String event(String name, Map<String, Object> properties) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("event", name);
        payload.put("properties", properties == null ? Map.of() : properties);
        return enqueue("event", payload);
    }

    public String error(Throwable error, Map<String, Object> properties) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", error.getClass().getSimpleName());
        payload.put("message", error.getMessage());
        payload.put("properties", properties == null ? Map.of() : properties);
        return enqueue("error", payload);
    }

    public String health(Map<String, Boolean> checks) {
        boolean ok = checks == null || checks.values().stream().allMatch(Boolean::booleanValue);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", ok);
        payload.put("checks", checks == null ? Map.of() : checks);
        return enqueue("health", payload);
    }

    public int queued() {
        return queue.size();
    }

    public String flush() throws IOException, InterruptedException {
        if (queue.isEmpty()) return "{\"sent\":0}";
        String body = "{\"items\":[" + String.join(",", queue) + "]}";
        HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint + "/api/ingest"))
            .header("content-type", "application/json")
            .POST(HttpRequest.BodyPublishers.ofString(body));
        if (apiKey != null && !apiKey.isBlank()) {
            builder.header("authorization", "Bearer " + apiKey);
        }
        HttpRequest request = builder.build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Reliability ingest failed: " + response.statusCode());
        }
        queue.clear();
        return response.body();
    }

    private String enqueue(String type, Map<String, Object> payload) {
        String item = "{"
            + "\"schema_version\":\"1.0\","
            + "\"type\":\"" + escape(type) + "\","
            + "\"product_id\":\"" + escape(productId) + "\","
            + "\"environment\":\"" + escape(environment) + "\","
            + "\"release\":\"" + escape(release) + "\","
            + "\"occurred_at\":\"" + Instant.now().toString() + "\","
            + "\"payload\":" + toJson(payload)
            + "}";
        queue.add(item);
        return item;
    }

    private static String toJson(Object value) {
        if (value == null) return "null";
        if (value instanceof String s) return "\"" + escape(s) + "\"";
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map<?, ?> map) {
            StringJoiner joiner = new StringJoiner(",", "{", "}");
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                joiner.add(toJson(String.valueOf(entry.getKey())) + ":" + toJson(entry.getValue()));
            }
            return joiner.toString();
        }
        return "\"" + escape(value.toString()) + "\"";
    }

    private static String escape(String value) {
        return value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r");
    }

    private static String trimTrailingSlash(String value) {
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
