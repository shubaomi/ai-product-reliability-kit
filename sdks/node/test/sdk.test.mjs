import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createReliabilityClient, healthPayload } from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.resolve(__dirname, "../../../standard/test/fixtures/protocol");

test("Node SDK sends an authenticated batch to a real HTTP collector", async () => {
  const received = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    received.push({ body: JSON.parse(body), authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ accepted: JSON.parse(body).items.length }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = createReliabilityClient({
      productId: "sdk-node-test",
      environment: "production",
      release: "test-sha",
      endpoint: `http://127.0.0.1:${server.address().port}`,
      apiKey: "node-sdk-key"
    });
    client.event("user_signed_up", { plan: "free" }, { anonymousId: "anon-1" });
    client.error(new Error("boom"), { requestId: "req-1" });
    client.health({ database: true, ai_api: true });

    const result = await client.flush();
    assert.equal(result.accepted, 3);
    assert.equal(client.queued().length, 0);
    assert.equal(received[0].authorization, "Bearer node-sdk-key");
    assert.match(received[0].body.items[0].idempotency_key, /^[0-9a-f-]{36}$/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Node SDK retries the same idempotent batch and requeues final failures without throwing", async () => {
  const bodies = [];
  let attempts = 0;
  const retrying = createReliabilityClient({
    productId: "sdk-node-retry",
    environment: "production",
    release: "test-sha",
    maxRetries: 1,
    baseDelayMs: 1,
    jitterRatio: 0,
    sleepImpl: async () => {},
    fetchImpl: async (_url, request) => {
      attempts += 1;
      bodies.push(request.body);
      if (attempts === 1) return response(503, { error: "offline" });
      return response(200, { accepted: 1 });
    }
  });
  retrying.event("retried_event");
  const success = await retrying.flush();
  assert.equal(success.accepted, 1);
  assert.equal(attempts, 2);
  assert.equal(bodies[0], bodies[1]);

  const offline = createReliabilityClient({
    productId: "sdk-node-offline",
    environment: "production",
    release: "test-sha",
    maxRetries: 1,
    baseDelayMs: 1,
    jitterRatio: 0,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw new Error("offline"); }
  });
  offline.event("preserved_event");
  const failed = await offline.flush();
  assert.equal(failed.failed, 1);
  assert.equal(offline.queued().length, 1);
});

test("Node SDK does not retry permanent HTTP failures and retries transient statuses", async (t) => {
  for (const status of [400, 401, 403]) {
    await t.test(`does not retry ${status}`, async () => {
      let attempts = 0;
      const client = createReliabilityClient({
        productId: `sdk-node-permanent-${status}`,
        environment: "production",
        release: "test-sha",
        maxRetries: 2,
        baseDelayMs: 0,
        jitterRatio: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          attempts += 1;
          return response(status, { error: "permanent" });
        }
      });
      client.event("permanent_failure");

      const result = await client.flush();

      assert.equal(result.failed, 1);
      assert.equal(result.attempts, 1);
      assert.equal(attempts, 1);
      assert.equal(client.queued().length, 1);
    });
  }

  for (const status of [408, 425, 429, 500, 503]) {
    await t.test(`retries ${status}`, async () => {
      let attempts = 0;
      const client = createReliabilityClient({
        productId: `sdk-node-transient-${status}`,
        environment: "production",
        release: "test-sha",
        maxRetries: 1,
        baseDelayMs: 0,
        jitterRatio: 0,
        sleepImpl: async () => {},
        fetchImpl: async () => {
          attempts += 1;
          return attempts === 1
            ? response(status, { error: "transient" })
            : response(200, { accepted: 1 });
        }
      });
      client.event("transient_failure");

      const result = await client.flush();

      assert.equal(result.accepted, 1);
      assert.equal(result.attempts, 2);
      assert.equal(attempts, 2);
      assert.equal(client.queued().length, 0);
    });
  }
});

test("Node SDK close drains items enqueued during an in-flight flush", async () => {
  let releaseFirstRequest;
  let signalFirstRequestStarted;
  const firstRequestStarted = new Promise((resolve) => {
    signalFirstRequestStarted = resolve;
  });
  const requests = [];
  const client = createReliabilityClient({
    productId: "sdk-node-close-race",
    environment: "production",
    release: "test-sha",
    closeTimeoutMs: 250,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requests.push(body.items.map((item) => item.payload.event));
      if (requests.length === 1) {
        signalFirstRequestStarted();
        await new Promise((resolve) => {
          releaseFirstRequest = resolve;
        });
      }
      return response(200, { accepted: body.items.length });
    }
  });
  client.event("first");
  const inFlight = client.flush();
  await firstRequestStarted;
  client.event("second");

  const closing = client.close();
  releaseFirstRequest();
  await inFlight;
  const result = await closing;

  assert.deepEqual(requests, [["first"], ["second"]]);
  assert.equal(result.accepted, 2);
  assert.equal(client.queued().length, 0);
});

test("Node SDK close applies its deadline to an in-flight flush", async () => {
  let signalRequestStarted;
  const requestStarted = new Promise((resolve) => {
    signalRequestStarted = resolve;
  });
  const client = createReliabilityClient({
    productId: "sdk-node-close-deadline",
    environment: "production",
    release: "test-sha",
    timeoutMs: 1000,
    closeTimeoutMs: 25,
    maxRetries: 0,
    fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
      signalRequestStarted();
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    })
  });
  client.event("slow_event");
  const inFlight = client.flush();
  await requestStarted;

  const startedAt = Date.now();
  const result = await client.close();
  const elapsedMs = Date.now() - startedAt;
  await inFlight;

  assert.equal(result.timed_out, true);
  assert.ok(elapsedMs < 250, `close exceeded its deadline: ${elapsedMs}ms`);
  assert.equal(client.queued().length, 1);
});

test("Node SDK close interrupts an already-running retry backoff at its deadline", async () => {
  let attempts = 0;
  let signalBackoffStarted;
  const backoffStarted = new Promise((resolve) => {
    signalBackoffStarted = resolve;
  });
  const client = createReliabilityClient({
    productId: "sdk-node-close-backoff",
    environment: "production",
    release: "test-sha",
    maxRetries: 1,
    baseDelayMs: 200,
    jitterRatio: 0,
    closeTimeoutMs: 20,
    sleepImpl: async (delay, signal) => new Promise((resolve) => {
      signalBackoffStarted();
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }),
    fetchImpl: async () => {
      attempts += 1;
      return response(503, { error: "transient" });
    }
  });
  client.event("backoff_event");
  const inFlight = client.flush();
  await backoffStarted;

  const startedAt = Date.now();
  const result = await client.close();
  const elapsedMs = Date.now() - startedAt;
  await inFlight;

  assert.equal(result.timed_out, true);
  assert.ok(elapsedMs < 150, `close waited for the full retry backoff: ${elapsedMs}ms`);
  assert.equal(attempts, 1);
  assert.equal(client.queued().length, 1);
});

test("Node SDK bounds the queue, counts drops, times out, and flushes on close", async () => {
  let sequence = 0;
  const bounded = createReliabilityClient({
    productId: "sdk-node-bounded",
    environment: "production",
    release: "test-sha",
    maxQueueSize: 2,
    idFactory: () => `id-${++sequence}`,
    fetchImpl: async () => response(200, { accepted: 2 })
  });
  bounded.event("first");
  bounded.event("second");
  bounded.event("third");
  assert.deepEqual(bounded.queued().map((item) => item.payload.event), ["second", "third"]);
  assert.equal(bounded.dropped(), 1);
  const closed = await bounded.close();
  assert.equal(closed.accepted, 2);
  assert.equal(bounded.queued().length, 0);
  assert.equal(bounded.event("after_close"), null);
  assert.equal(bounded.dropped(), 2);

  const timingOut = createReliabilityClient({
    productId: "sdk-node-timeout",
    environment: "production",
    release: "test-sha",
    timeoutMs: 20,
    maxRetries: 0,
    fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    })
  });
  timingOut.event("timeout_event");
  const timeout = await timingOut.flush();
  assert.equal(timeout.failed, 1);
  assert.equal(timeout.timed_out, true);
  assert.equal(timingOut.queued().length, 1);
});

test("Node SDK consumes the shared versioned contract cases", async () => {
  const cases = JSON.parse(await fs.readFile(path.join(fixtureDir, "contract-cases.json"), "utf8"));
  for (const schemaVersion of cases.supported_versions) {
    const client = createReliabilityClient({
      productId: "fixture-product",
      environment: "production",
      release: "git:fixture",
      schemaVersion,
      idFactory: () => "fixture-id",
      fetchImpl: async () => response(200, { accepted: 1 })
    });
    const item = client.event("fixture_completed");
    for (const field of cases.required_fields) assert.ok(Object.hasOwn(item, field), `${schemaVersion} missing ${field}`);
    assert.equal(item.schema_version, schemaVersion);
  }
  assert.deepEqual(healthPayload({ database: true, cache: false }), {
    ok: false,
    checks: { database: true, cache: false }
  });
});

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}
