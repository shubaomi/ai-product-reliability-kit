package com.aiproductreliability;

import java.io.IOException;
import java.lang.reflect.Array;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayDeque;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.StringJoiner;
import java.util.Deque;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Dependency-free server-side client for the AI Product Reliability ingest API.
 *
 * <p>The in-memory queue is bounded and fail-open by default. A failed batch is
 * placed back at the front of the queue, and every retry sends the exact same
 * serialized body so item idempotency keys remain stable.</p>
 */
public final class ReliabilityClient implements AutoCloseable {
    @FunctionalInterface
    public interface IdFactory {
        String create();
    }

    /** Mutable builder-style options copied when a client is constructed. */
    public static final class Options {
        private String schemaVersion = "1.0";
        private long timeoutMillis = 2_000;
        private int maxRetries = 3;
        private long baseDelayMillis = 100;
        private long maxDelayMillis = 5_000;
        private double jitterRatio = 0.2;
        private int maxQueueSize = 1_000;
        private long closeTimeoutMillis = 5_000;
        private boolean failOpen = true;
        private IdFactory idFactory = () -> UUID.randomUUID().toString();

        public Options schemaVersion(String value) {
            if (value == null || !value.matches("1\\.\\d+")) {
                throw new IllegalArgumentException("Unsupported schema version: " + value);
            }
            this.schemaVersion = value;
            return this;
        }

        public Options timeoutMillis(long value) {
            this.timeoutMillis = positive(value, "timeoutMillis");
            return this;
        }

        public Options maxRetries(int value) {
            if (value < 0) throw new IllegalArgumentException("maxRetries must be non-negative");
            this.maxRetries = value;
            return this;
        }

        public Options baseDelayMillis(long value) {
            if (value < 0) throw new IllegalArgumentException("baseDelayMillis must be non-negative");
            this.baseDelayMillis = value;
            return this;
        }

        public Options maxDelayMillis(long value) {
            this.maxDelayMillis = positive(value, "maxDelayMillis");
            return this;
        }

        public Options jitterRatio(double value) {
            if (!Double.isFinite(value) || value < 0 || value > 1) {
                throw new IllegalArgumentException("jitterRatio must be between 0 and 1");
            }
            this.jitterRatio = value;
            return this;
        }

        public Options maxQueueSize(int value) {
            if (value <= 0) throw new IllegalArgumentException("maxQueueSize must be positive");
            this.maxQueueSize = value;
            return this;
        }

        public Options closeTimeoutMillis(long value) {
            this.closeTimeoutMillis = positive(value, "closeTimeoutMillis");
            return this;
        }

        public Options failOpen(boolean value) {
            this.failOpen = value;
            return this;
        }

        public Options idFactory(IdFactory value) {
            if (value == null) throw new IllegalArgumentException("idFactory is required");
            this.idFactory = value;
            return this;
        }

        private static long positive(long value, String name) {
            if (value <= 0) throw new IllegalArgumentException(name + " must be positive");
            return value;
        }
    }

    /** Optional identity and request correlation fields for one envelope. */
    public static final class Context {
        private String occurredAt;
        private String anonymousId;
        private String userId;
        private String requestId;
        private String idempotencyKey;

        public Context occurredAt(String value) { this.occurredAt = value; return this; }
        public Context anonymousId(String value) { this.anonymousId = value; return this; }
        public Context userId(String value) { this.userId = value; return this; }
        public Context requestId(String value) { this.requestId = value; return this; }
        public Context idempotencyKey(String value) { this.idempotencyKey = value; return this; }
    }

    private final String productId;
    private final String environment;
    private final String release;
    private final String endpoint;
    private final String apiKey;
    private final HttpClient httpClient;
    private final String schemaVersion;
    private final long timeoutMillis;
    private final int maxRetries;
    private final long baseDelayMillis;
    private final long maxDelayMillis;
    private final double jitterRatio;
    private final int maxQueueSize;
    private final long closeTimeoutMillis;
    private final boolean failOpen;
    private final IdFactory idFactory;
    private final List<String> queue = new ArrayList<>();
    private final Deque<CompletedFlush> completedFlushes = new ArrayDeque<>();
    private long droppedCount;
    private boolean closed;
    private boolean flushActive;
    private boolean closing;
    private long flushGeneration;

    public ReliabilityClient(String productId, String environment, String release, String endpoint) {
        this(productId, environment, release, endpoint, null, new Options());
    }

    public ReliabilityClient(String productId, String environment, String release, String endpoint, String apiKey) {
        this(productId, environment, release, endpoint, apiKey, new Options());
    }

    public ReliabilityClient(
        String productId,
        String environment,
        String release,
        String endpoint,
        String apiKey,
        Options options
    ) {
        this.productId = required(productId, "productId");
        this.environment = required(environment, "environment");
        this.release = required(release, "release");
        Options resolved = options == null ? new Options() : options;
        this.endpoint = validateEndpoint(endpoint == null || endpoint.isBlank() ? "http://127.0.0.1:8787" : endpoint);
        this.apiKey = apiKey;
        this.httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofMillis(resolved.timeoutMillis))
            .build();
        this.schemaVersion = resolved.schemaVersion;
        this.timeoutMillis = resolved.timeoutMillis;
        this.maxRetries = resolved.maxRetries;
        this.baseDelayMillis = resolved.baseDelayMillis;
        this.maxDelayMillis = resolved.maxDelayMillis;
        this.jitterRatio = resolved.jitterRatio;
        this.maxQueueSize = resolved.maxQueueSize;
        this.closeTimeoutMillis = resolved.closeTimeoutMillis;
        this.failOpen = resolved.failOpen;
        this.idFactory = resolved.idFactory;
    }

    public String event(String name, Map<String, Object> properties) {
        return event(name, properties, new Context());
    }

    public String event(String name, Map<String, Object> properties, Context context) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("event", required(name, "event name"));
        payload.put("properties", properties == null ? Map.of() : properties);
        return enqueue("event", payload, context);
    }

    public String error(Throwable error, Map<String, Object> properties) {
        return error(error, properties, false, new Context());
    }

    public String error(Throwable error, Map<String, Object> properties, boolean includeStack, Context context) {
        if (error == null) throw new IllegalArgumentException("error is required");
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("name", error.getClass().getSimpleName());
        payload.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
        if (includeStack) {
            List<String> frames = new ArrayList<>();
            for (StackTraceElement frame : error.getStackTrace()) frames.add(frame.toString());
            payload.put("stack", frames);
        }
        payload.put("properties", properties == null ? Map.of() : properties);
        return enqueue("error", payload, context);
    }

    public String health(Map<String, Boolean> checks) {
        return health(checks, new Context());
    }

    public String health(Map<String, Boolean> checks, Context context) {
        Map<String, Boolean> normalized = checks == null ? Map.of() : new LinkedHashMap<>(checks);
        boolean ok = normalized.values().stream().allMatch(Boolean.TRUE::equals);
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("ok", ok);
        payload.put("checks", normalized);
        return enqueue("health", payload, context);
    }

    public String release(String version, Map<String, Object> properties) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("version", required(version, "release version"));
        payload.put("properties", properties == null ? Map.of() : properties);
        return enqueue("release", payload, new Context());
    }

    public String product(Map<String, Object> contract) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("contract", contract == null ? Map.of() : contract);
        return enqueue("product", payload, new Context());
    }

    public synchronized int queued() {
        return queue.size();
    }

    public synchronized long dropped() {
        return droppedCount;
    }

    public synchronized boolean isClosed() {
        return closed;
    }

    public String flush() throws IOException, InterruptedException {
        return flushResultUntil(Long.MAX_VALUE, false).response;
    }

    /** Flushes queued data before marking the client closed. */
    public String closeAndFlush() throws IOException, InterruptedException {
        long deadline = System.nanoTime() + Duration.ofMillis(closeTimeoutMillis).toNanos();
        long startGeneration;
        synchronized (this) {
            closed = true;
            if (closing) {
                while (closing && waitForFlushSlot(deadline)) {
                    // The first close owns the drain. A concurrent close only joins it.
                }
                return closing ? FlushResult.timedOut().closeResponse() : resultJson(0, 0, 0, false, null);
            }
            closing = true;
            startGeneration = flushGeneration;
        }
        FlushResult fallback = FlushResult.empty();
        try {
            while (true) {
                fallback = flushResultUntil(deadline, true);
                if (fallback.failed > 0 || fallback.timedOut) break;
                synchronized (this) {
                    if (!flushActive && queue.isEmpty()) break;
                }
                if (remainingMillis(deadline) <= 0) {
                    fallback = FlushResult.timedOut();
                    break;
                }
            }
            return closeResponseSince(startGeneration, fallback);
        } finally {
            synchronized (this) {
                closing = false;
                notifyAll();
            }
        }
    }

    @Override
    public void close() throws IOException {
        try {
            closeAndFlush();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new IOException("Interrupted while flushing reliability events", error);
        }
    }

    private FlushResult flushResultUntil(long deadlineNanos, boolean closeOwner) throws IOException, InterruptedException {
        List<String> batch;
        synchronized (this) {
            while (flushActive || (!closeOwner && closing)) {
                if (!waitForFlushSlot(deadlineNanos)) return FlushResult.timedOut();
            }
            if (queue.isEmpty()) return FlushResult.empty();
            batch = new ArrayList<>(queue);
            queue.clear();
            flushActive = true;
        }

        FlushResult completed = null;
        try {
            completed = sendBatch(batch, deadlineNanos);
            return completed;
        } catch (IOException error) {
            completed = FlushResult.failure(batch.size(), error);
            throw error;
        } catch (InterruptedException error) {
            completed = FlushResult.failure(batch.size(), error);
            throw error;
        } finally {
            completeFlush(completed);
        }
    }

    private FlushResult sendBatch(List<String> batch, long deadlineNanos) throws IOException, InterruptedException {

        String body = "{\"items\":[" + String.join(",", batch) + "]}";
        IOException lastError = null;
        int attempts = 0;
        boolean timedOut = false;

        for (int attempt = 0; attempt <= maxRetries; attempt += 1) {
            long remainingMillis = remainingMillis(deadlineNanos);
            if (remainingMillis <= 0) {
                timedOut = true;
                lastError = new IOException("Reliability close deadline exceeded");
                break;
            }

            attempts += 1;
            long requestTimeout = Math.max(1, Math.min(timeoutMillis, remainingMillis));
            HttpRequest.Builder builder = HttpRequest.newBuilder(URI.create(endpoint + "/api/ingest"))
                .timeout(Duration.ofMillis(requestTimeout))
                .header("content-type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body));
            if (apiKey != null && !apiKey.isBlank()) {
                builder.header("authorization", "Bearer " + apiKey);
            }

            boolean retryable = true;
            try {
                HttpResponse<String> response = httpClient.send(builder.build(), HttpResponse.BodyHandlers.ofString());
                if (response.statusCode() >= 200 && response.statusCode() < 300) {
                    String responseBody = response.body();
                    return FlushResult.success(batch.size(), attempts, responseBody);
                }
                int status = response.statusCode();
                retryable = status == 408 || status == 425 || status == 429 || status >= 500;
                lastError = new IOException("Reliability ingest failed: " + status);
            } catch (IOException error) {
                lastError = error;
                timedOut = error instanceof java.net.http.HttpTimeoutException;
            } catch (InterruptedException error) {
                requeue(batch);
                throw error;
            }

            if (!retryable || attempt >= maxRetries) break;
            long delay = retryDelayMillis(attempt);
            if (delay <= 0) continue;
            long afterDelay = remainingMillis(deadlineNanos) - delay;
            if (afterDelay <= 0) {
                timedOut = true;
                break;
            }
            Thread.sleep(delay);
        }

        requeue(batch);
        FlushResult result = new FlushResult(
            0,
            batch.size(),
            attempts,
            timedOut,
            lastError == null ? null : lastError.getMessage(),
            resultJson(0, batch.size(), attempts, timedOut, lastError == null ? null : lastError.getMessage())
        );
        if (failOpen) return result;
        throw lastError == null ? new IOException("Reliability ingest failed") : lastError;
    }

    private synchronized boolean waitForFlushSlot(long deadlineNanos) throws InterruptedException {
        if (deadlineNanos == Long.MAX_VALUE) {
            wait();
            return true;
        }
        long remainingNanos = deadlineNanos - System.nanoTime();
        if (remainingNanos <= 0) return false;
        long millis = remainingNanos / 1_000_000;
        int nanos = (int) (remainingNanos % 1_000_000);
        wait(millis, nanos);
        return true;
    }

    private void completeFlush(FlushResult result) {
        FlushResult completed = result == null ? FlushResult.failure(0, new IOException("Reliability ingest failed")) : result;
        synchronized (this) {
            flushActive = false;
            flushGeneration += 1;
            completedFlushes.addLast(new CompletedFlush(flushGeneration, completed));
            while (completedFlushes.size() > 32) completedFlushes.removeFirst();
            notifyAll();
        }
    }

    private String closeResponseSince(long startGeneration, FlushResult fallback) {
        List<FlushResult> completed = new ArrayList<>();
        synchronized (this) {
            for (CompletedFlush flush : completedFlushes) {
                if (flush.generation > startGeneration) completed.add(flush.result);
            }
        }
        if (completed.isEmpty()) return fallback.closeResponse();
        int sent = 0;
        int failed = 0;
        int attempts = 0;
        boolean timedOut = false;
        String error = null;
        for (FlushResult result : completed) {
            sent += result.sent;
            failed += result.failed;
            attempts += result.attempts;
            timedOut |= result.timedOut;
            if (error == null && result.error != null) error = result.error;
        }
        return resultJson(sent, failed, attempts, timedOut, error);
    }

    private static final class CompletedFlush {
        private final long generation;
        private final FlushResult result;

        private CompletedFlush(long generation, FlushResult result) {
            this.generation = generation;
            this.result = result;
        }
    }

    private static final class FlushResult {
        private final int sent;
        private final int failed;
        private final int attempts;
        private final boolean timedOut;
        private final String error;
        private final String response;

        private FlushResult(int sent, int failed, int attempts, boolean timedOut, String error, String response) {
            this.sent = sent;
            this.failed = failed;
            this.attempts = attempts;
            this.timedOut = timedOut;
            this.error = error;
            this.response = response;
        }

        private static FlushResult empty() {
            return new FlushResult(0, 0, 0, false, null, resultJson(0, 0, 0, false, null));
        }

        private static FlushResult timedOut() {
            String error = "Reliability close deadline exceeded";
            return new FlushResult(0, 0, 0, true, error, resultJson(0, 0, 0, true, error));
        }

        private static FlushResult success(int sent, int attempts, String response) {
            String output = response == null || response.isBlank()
                ? resultJson(sent, 0, attempts, false, null)
                : response;
            return new FlushResult(sent, 0, attempts, false, null, output);
        }

        private static FlushResult failure(int failed, Exception error) {
            String message = error == null ? "Reliability ingest failed" : error.getMessage();
            return new FlushResult(0, failed, 0, false, message, resultJson(0, failed, 0, false, message));
        }

        private String closeResponse() {
            return resultJson(sent, failed, attempts, timedOut, error);
        }
    }

    private String enqueue(String type, Map<String, Object> payload, Context providedContext) {
        Context context = providedContext == null ? new Context() : providedContext;
        synchronized (this) {
            if (closed) {
                droppedCount += 1;
                return null;
            }
            Map<String, Object> envelope = new LinkedHashMap<>();
            envelope.put("schema_version", schemaVersion);
            envelope.put("type", type);
            envelope.put("product_id", productId);
            envelope.put("environment", environment);
            envelope.put("release", release);
            envelope.put("occurred_at", context.occurredAt == null ? Instant.now().toString() : context.occurredAt);
            putIfPresent(envelope, "anonymous_id", context.anonymousId);
            putIfPresent(envelope, "user_id", context.userId);
            putIfPresent(envelope, "request_id", context.requestId);
            envelope.put("idempotency_key", context.idempotencyKey == null ? idFactory.create() : context.idempotencyKey);
            envelope.put("payload", payload);
            String item = toJson(envelope);
            if (queue.size() >= maxQueueSize) {
                queue.remove(0);
                droppedCount += 1;
            }
            queue.add(item);
            return item;
        }
    }

    private synchronized void requeue(List<String> batch) {
        List<String> combined = new ArrayList<>(batch.size() + queue.size());
        combined.addAll(batch);
        combined.addAll(queue);
        if (combined.size() > maxQueueSize) {
            droppedCount += combined.size() - maxQueueSize;
            combined = new ArrayList<>(combined.subList(0, maxQueueSize));
        }
        queue.clear();
        queue.addAll(combined);
    }

    private long retryDelayMillis(int attempt) {
        double exponential = Math.min(maxDelayMillis, baseDelayMillis * Math.pow(2, attempt));
        double random = ThreadLocalRandom.current().nextDouble();
        double jitter = 1 + (((random * 2) - 1) * jitterRatio);
        return Math.max(0, Math.round(exponential * jitter));
    }

    private static long remainingMillis(long deadlineNanos) {
        if (deadlineNanos == Long.MAX_VALUE) return Long.MAX_VALUE;
        long remaining = deadlineNanos - System.nanoTime();
        return remaining <= 0 ? 0 : Math.max(1, Duration.ofNanos(remaining).toMillis());
    }

    private static String resultJson(int sent, int failed, int attempts, boolean timedOut, String error) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("sent", sent);
        result.put("failed", failed);
        result.put("attempts", attempts);
        result.put("timed_out", timedOut);
        if (error != null) result.put("error", error);
        return toJson(result);
    }

    private static String toJson(Object value) {
        if (value == null) return "null";
        if (value instanceof String || value instanceof Character || value instanceof Enum<?>) {
            return "\"" + escape(String.valueOf(value)) + "\"";
        }
        if (value instanceof Boolean) return value.toString();
        if (value instanceof Number number) {
            if ((number instanceof Double d && !Double.isFinite(d)) || (number instanceof Float f && !Float.isFinite(f))) {
                return "null";
            }
            return number.toString();
        }
        if (value instanceof Map<?, ?> map) {
            StringJoiner joiner = new StringJoiner(",", "{", "}");
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                joiner.add(toJson(String.valueOf(entry.getKey())) + ":" + toJson(entry.getValue()));
            }
            return joiner.toString();
        }
        if (value instanceof Iterable<?> iterable) {
            StringJoiner joiner = new StringJoiner(",", "[", "]");
            for (Object item : iterable) joiner.add(toJson(item));
            return joiner.toString();
        }
        if (value.getClass().isArray()) {
            StringJoiner joiner = new StringJoiner(",", "[", "]");
            for (int index = 0; index < Array.getLength(value); index += 1) joiner.add(toJson(Array.get(value, index)));
            return joiner.toString();
        }
        return "\"" + escape(value.toString()) + "\"";
    }

    private static String escape(String value) {
        StringBuilder output = new StringBuilder(value.length() + 8);
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            switch (character) {
                case '\\' -> output.append("\\\\");
                case '"' -> output.append("\\\"");
                case '\b' -> output.append("\\b");
                case '\f' -> output.append("\\f");
                case '\n' -> output.append("\\n");
                case '\r' -> output.append("\\r");
                case '\t' -> output.append("\\t");
                default -> {
                    if (character < 0x20) output.append(String.format("\\u%04x", (int) character));
                    else output.append(character);
                }
            }
        }
        return output.toString();
    }

    private static void putIfPresent(Map<String, Object> target, String key, String value) {
        if (value != null) target.put(key, value);
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value;
    }

    private static String validateEndpoint(String value) {
        String trimmed = value.replaceAll("/+$", "");
        URI uri;
        try {
            uri = URI.create(trimmed);
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("endpoint must be a valid HTTP(S) URL", error);
        }
        if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme())) || uri.getHost() == null) {
            throw new IllegalArgumentException("endpoint must be an absolute HTTP(S) URL");
        }
        return trimmed;
    }
}
