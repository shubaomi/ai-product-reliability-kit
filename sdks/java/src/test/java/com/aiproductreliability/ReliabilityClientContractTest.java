package com.aiproductreliability;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

public final class ReliabilityClientContractTest {
    public static void main(String[] args) throws Exception {
        Path repoRoot = Path.of(args.length == 0 ? "." : args[0]).toAbsolutePath();
        verifiesBoundedQueueAndDropCount();
        verifiesRetryUsesSameIdempotentBatch();
        verifiesFailOpenRequeuesFinalFailure();
        verifiesCloseJoinsConcurrentFlushAndDrainsRaceEnqueue();
        verifiesCloseDeadlineWhileConcurrentFlushIsActive();
        verifiesSharedContractCases(repoRoot);
        System.out.println("Java SDK contract tests OK");
    }

    private static void verifiesBoundedQueueAndDropCount() {
        ReliabilityClient.Options options = new ReliabilityClient.Options()
            .maxQueueSize(2)
            .idFactory(new ReliabilityClient.IdFactory() {
                private int value;
                public String create() { return "id-" + (++value); }
            });
        ReliabilityClient client = new ReliabilityClient("java-bounded", "production", "release", "http://127.0.0.1:1", null, options);
        client.event("first", Map.of());
        client.event("second", Map.of());
        client.event("third", Map.of("tags", List.of("one", "two")));
        check(client.queued() == 2, "queue must stay bounded");
        check(client.dropped() == 1, "drop counter must increment");
    }

    private static void verifiesRetryUsesSameIdempotentBatch() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        List<String> bodies = new ArrayList<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/ingest", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            bodies.add(body);
            int status = attempts.incrementAndGet() == 1 ? 503 : 200;
            byte[] response = "{\"accepted\":1}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        try {
            ReliabilityClient.Options options = new ReliabilityClient.Options()
                .maxRetries(1)
                .baseDelayMillis(1)
                .jitterRatio(0)
                .timeoutMillis(1000);
            ReliabilityClient client = new ReliabilityClient(
                "java-retry", "production", "release",
                "http://127.0.0.1:" + server.getAddress().getPort(), "java-key", options
            );
            client.event("retried_event", Map.of("tags", List.of("one", "two")));
            String result = client.flush();
            check(result.contains("accepted"), "successful response must be returned");
            check(attempts.get() == 2, "one retry must occur");
            check(bodies.get(0).equals(bodies.get(1)), "retry must keep the exact same batch");
            check(bodies.get(0).contains("\"idempotency_key\""), "batch must contain idempotency key");
            check(bodies.get(0).contains("[\"one\",\"two\"]"), "lists must be encoded as JSON arrays");
            check(client.queued() == 0, "successful batch must clear queue");
            client.close();
        } finally {
            server.stop(0);
        }
    }

    private static void verifiesFailOpenRequeuesFinalFailure() throws Exception {
        ReliabilityClient.Options options = new ReliabilityClient.Options()
            .maxRetries(0)
            .timeoutMillis(50)
            .failOpen(true);
        ReliabilityClient client = new ReliabilityClient("java-offline", "production", "release", "http://127.0.0.1:1", null, options);
        client.event("preserved_event", Map.of());
        String result = client.flush();
        check(result.contains("\"failed\":1"), "fail-open result must report the failed batch");
        check(client.queued() == 1, "failed batch must be requeued");
    }

    private static void verifiesCloseJoinsConcurrentFlushAndDrainsRaceEnqueue() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        List<String> bodies = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch firstStarted = new CountDownLatch(1);
        CountDownLatch releaseFirst = new CountDownLatch(1);
        CountDownLatch closeDone = new CountDownLatch(1);
        ExecutorService serverExecutor = Executors.newCachedThreadPool();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(serverExecutor);
        server.createContext("/api/ingest", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            bodies.add(body);
            int callNumber = attempts.incrementAndGet();
            if (callNumber == 1) {
                firstStarted.countDown();
                try {
                    releaseFirst.await(2, TimeUnit.SECONDS);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                }
            }
            byte[] response = "{\"accepted\":1}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        AtomicReference<Throwable> flushError = new AtomicReference<>();
        AtomicReference<Throwable> closeError = new AtomicReference<>();
        AtomicReference<String> closeResult = new AtomicReference<>();
        try {
            ReliabilityClient.Options options = new ReliabilityClient.Options()
                .maxRetries(0)
                .timeoutMillis(1_000)
                .closeTimeoutMillis(1_000);
            ReliabilityClient client = new ReliabilityClient(
                "java-close-race", "production", "release",
                "http://127.0.0.1:" + server.getAddress().getPort(), null, options
            );
            client.event("first", Map.of());
            Thread flushThread = new Thread(() -> {
                try {
                    client.flush();
                } catch (Throwable error) {
                    flushError.set(error);
                }
            });
            flushThread.start();
            check(firstStarted.await(1, TimeUnit.SECONDS), "first concurrent flush must start");
            client.event("second", Map.of());
            Thread closeThread = new Thread(() -> {
                try {
                    closeResult.set(client.closeAndFlush());
                } catch (Throwable error) {
                    closeError.set(error);
                } finally {
                    closeDone.countDown();
                }
            });
            closeThread.start();
            boolean closedBeforeRelease = closeDone.await(50, TimeUnit.MILLISECONDS);
            int attemptsBeforeRelease = attempts.get();
            releaseFirst.countDown();
            flushThread.join(2_000);
            closeThread.join(2_000);

            check(!closedBeforeRelease, "close must join the in-flight flush before returning");
            check(attemptsBeforeRelease == 1, "close must not send concurrently with an active flush");
            check(!flushThread.isAlive() && !closeThread.isAlive(), "SDK threads must finish");
            check(flushError.get() == null, "concurrent flush must succeed");
            check(closeError.get() == null, "close must succeed");
            check(attempts.get() == 2, "close must drain the event queued during the active flush");
            check(bodies.get(0).contains("\"event\":\"first\""), "first batch must contain first event");
            check(bodies.get(1).contains("\"event\":\"second\""), "second batch must contain second event");
            check(closeResult.get().contains("\"sent\":2"), "close result must cover both drained batches");
            check(client.queued() == 0, "close must leave no queued events after successful drains");
        } finally {
            releaseFirst.countDown();
            server.stop(0);
            serverExecutor.shutdownNow();
        }
    }

    private static void verifiesCloseDeadlineWhileConcurrentFlushIsActive() throws Exception {
        CountDownLatch requestStarted = new CountDownLatch(1);
        CountDownLatch releaseRequest = new CountDownLatch(1);
        ExecutorService serverExecutor = Executors.newCachedThreadPool();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.setExecutor(serverExecutor);
        server.createContext("/api/ingest", exchange -> {
            requestStarted.countDown();
            try {
                releaseRequest.await(2, TimeUnit.SECONDS);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
            }
            byte[] response = "{\"accepted\":1}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
            exchange.close();
        });
        server.start();
        AtomicReference<Throwable> flushError = new AtomicReference<>();
        try {
            ReliabilityClient.Options options = new ReliabilityClient.Options()
                .maxRetries(0)
                .timeoutMillis(1_000)
                .closeTimeoutMillis(20);
            ReliabilityClient client = new ReliabilityClient(
                "java-close-deadline", "production", "release",
                "http://127.0.0.1:" + server.getAddress().getPort(), null, options
            );
            client.event("slow_event", Map.of());
            Thread flushThread = new Thread(() -> {
                try {
                    client.flush();
                } catch (Throwable error) {
                    flushError.set(error);
                }
            });
            flushThread.start();
            check(requestStarted.await(1, TimeUnit.SECONDS), "concurrent request must start");

            long startedAt = System.nanoTime();
            String result = client.closeAndFlush();
            long elapsedMillis = Duration.ofNanos(System.nanoTime() - startedAt).toMillis();
            releaseRequest.countDown();
            flushThread.join(2_000);

            check(result.contains("\"timed_out\":true"), "close must report an expired join deadline");
            check(elapsedMillis < 200, "close must be deadline-bounded, elapsed=" + elapsedMillis);
            check(!flushThread.isAlive(), "original flush must finish after release");
            check(flushError.get() == null, "original flush must remain successful");
            check(client.queued() == 0, "successful in-flight batch must not be requeued");
        } finally {
            releaseRequest.countDown();
            server.stop(0);
            serverExecutor.shutdownNow();
        }
    }

    private static void verifiesSharedContractCases(Path repoRoot) throws IOException {
        String cases = Files.readString(repoRoot.resolve("standard/test/fixtures/protocol/contract-cases.json"));
        for (String version : List.of("1.0", "1.1", "1.9")) {
            check(cases.contains("\"" + version + "\""), "shared fixture must list " + version);
            ReliabilityClient client = new ReliabilityClient(
                "fixture-product", "production", "git:fixture", "http://127.0.0.1:1", null,
                new ReliabilityClient.Options().schemaVersion(version).idFactory(() -> "fixture-id")
            );
            String item = client.event("fixture_completed", Map.of());
            for (String field : List.of("schema_version", "type", "product_id", "environment", "release", "occurred_at", "payload", "idempotency_key")) {
                check(item.contains("\"" + field + "\""), version + " missing " + field);
            }
            check(item.contains("\"schema_version\":\"" + version + "\""), "schema version must match option");
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
}
