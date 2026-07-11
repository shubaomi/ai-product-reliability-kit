import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";
import { hashSecret } from "../src/security.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

const MASTER_KEY = "m".repeat(40);
const INGEST_KEY = "i".repeat(40);
const VALID_PASSWORD_HASH = `pbkdf2_sha256$210000$0123456789abcdef$${"a".repeat(64)}`;

function config(overrides = {}) {
  return {
    authRequired: true,
    masterApiKey: MASTER_KEY,
    ingestApiKey: INGEST_KEY,
    sessionSecret: "s".repeat(40),
    userIdHmacSecret: "u".repeat(40),
    maxBodyBytes: 32 * 1024,
    maxBatchSize: 20,
    rateLimitWindowMs: 60_000,
    rateLimitMax: 100,
    loginRateLimitMax: 10,
    ingestRateLimitMax: 100,
    trustedProxyIps: [],
    allowedMonitorHosts: [],
    corsOrigins: [],
    workerEnabled: false,
    ...overrides
  };
}

async function withServer(options, callback) {
  const server = await createDashboardServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await callback({ server, base });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body };
}

function adminHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` };
}

function envelope(overrides = {}) {
  return {
    schema_version: "1.0",
    type: "event",
    product_id: "phase2-product",
    environment: "production",
    release: "test-release",
    occurred_at: new Date().toISOString(),
    payload: { event: "phase2_event", properties: {} },
    ...overrides
  };
}

async function createProduct(base, productId) {
  const { response } = await requestJson(base, "/api/products", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      product_id: productId,
      name: productId,
      owner: "owner@example.com",
      standard_version: "1.0",
      environments: [{ name: "production", url: "https://example.com" }]
    })
  });
  assert.equal(response.status, 200);
}

test("production startup fails closed for missing, placeholder, invalid URL, and insecure auth config", async () => {
  await assert.rejects(
    () => createDashboardServer({ memory: true, env: { NODE_ENV: "production" } }),
    /production|DATABASE_URL|required/i
  );

  const valid = {
    NODE_ENV: "production",
    APR_STORE_MODE: "postgres",
    DATABASE_URL: "postgres://apr:strong-password@127.0.0.1:5432/apr",
    PUBLIC_BASE_URL: "https://reliability.hihongrun.com",
    APR_AUTH_REQUIRED: "true",
    APR_ADMIN_EMAIL: "ops@hihongrun.com",
    APR_ADMIN_PASSWORD_HASH: VALID_PASSWORD_HASH,
    APR_MASTER_API_KEY: "a".repeat(40),
    APR_INGEST_API_KEY: "b".repeat(40),
    APR_SESSION_SECRET: "c".repeat(40),
    APR_USER_ID_HMAC_SECRET: "d".repeat(40),
    APR_TRUSTED_PROXIES: "127.0.0.1,::1"
  };

  await assert.rejects(
    () => createDashboardServer({ memory: true, env: { ...valid, APR_MASTER_API_KEY: "replace-with-master-key" } }),
    /master.*key|placeholder|unsafe/i
  );
  await assert.rejects(
    () => createDashboardServer({ memory: true, env: { ...valid, PUBLIC_BASE_URL: "http://reliability.hihongrun.com" } }),
    /PUBLIC_BASE_URL|https/i
  );
  await assert.rejects(
    () => createDashboardServer({ memory: true, env: { ...valid, APR_AUTH_REQUIRED: "false" } }),
    /auth/i
  );
  await assert.rejects(
    () => createDashboardServer({ memory: true, env: { ...valid, APR_ADMIN_PASSWORD_HASH: "pbkdf2_sha256$210000$salt$not-a-real-hash" } }),
    /password.*hash|pbkdf2/i
  );

  const server = await createDashboardServer({ memory: true, env: valid });
  assert.ok(server);
});

test("malformed JSON is a 400 response", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    const { response, body } = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: "{"
    });
    assert.equal(response.status, 400);
    assert.match(body.error, /json/i);
  });
});

test("collector returns v1.x compatibility warnings and explicit unknown-major errors", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    await createProduct(base, "compat-product");
    const legacy = envelope({
      product_id: "compat-product",
      schema_version: "1.0",
      timestamp: new Date().toISOString()
    });
    delete legacy.occurred_at;
    let result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(legacy)
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.accepted, 1);
    assert.ok(result.body.warnings.some((warning) => warning.field === "timestamp"));
    assert.ok(result.body.migration_advice.some((advice) => /1\.1/.test(advice)));

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope({ product_id: "compat-product", schema_version: "2.0" }))
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.code, "unsupported_major");
    assert.match(result.body.error, /supports v1\.x/i);
  });
});

test("telemetry validates field types, lengths, timestamp skew, and applies privacy transforms", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    let result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope({ product_id: 42 }))
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope({ product_id: "x".repeat(129) }))
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope({ occurred_at: "2099-01-01T00:00:00.000Z" }))
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify({ items: Array.from({ length: 21 }, () => envelope()) })
    });
    assert.equal(result.response.status, 413);

    result = await requestJson(base, "/api/products", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        product_id: "bad-url-product",
        name: "Bad URL",
        owner: "owner@example.com",
        standard_version: "1.0",
        environments: [{ name: "production", url: "file:///etc/passwd" }]
      })
    });
    assert.equal(result.response.status, 400);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope({
        user_id: "raw-user@example.com",
        payload: {
          event: "privacy_event",
          properties: {
            nested: { authorization: "Bearer secret", visible: "yes" },
            user_id: "nested-user@example.com"
          }
        }
      }))
    });
    assert.equal(result.response.status, 200);

    const events = await requestJson(base, "/api/events", {
      headers: { authorization: `Bearer ${MASTER_KEY}` }
    });
    assert.equal(events.response.status, 200);
    assert.match(events.body[0].user_id, /^hmac_sha256:[a-f0-9]{64}$/);
    assert.match(events.body[0].payload.properties.user_id, /^hmac_sha256:[a-f0-9]{64}$/);
    assert.equal(events.body[0].payload.properties.nested.authorization, "[REDACTED]");
    assert.equal(events.body[0].payload.properties.nested.visible, "yes");
  });
});

test("untrusted forwarded IP cannot bypass limits and login/ingest buckets are independent", async () => {
  await withServer({
    memory: true,
    config: config({ rateLimitMax: 1, loginRateLimitMax: 1, ingestRateLimitMax: 1 })
  }, async ({ base }) => {
    const first = await fetch(`${base}/api/status`, { headers: { "x-forwarded-for": "198.51.100.1" } });
    const second = await fetch(`${base}/api/status`, { headers: { "x-forwarded-for": "198.51.100.2" } });
    assert.equal(first.status, 200);
    assert.equal(second.status, 429);
  });

  await withServer({
    memory: true,
    config: config({ rateLimitMax: 100, loginRateLimitMax: 1, ingestRateLimitMax: 1 })
  }, async ({ base }) => {
    const login = await fetch(`${base}/api/session/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", password: "wrong" })
    });
    assert.equal(login.status, 401);

    const ingest = await fetch(`${base}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${INGEST_KEY}` },
      body: JSON.stringify(envelope())
    });
    assert.equal(ingest.status, 200);
  });
});

test("monitor registration rejects SSRF targets", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    await createProduct(base, "ssrf-product");
    for (const url of [
      "file:///etc/passwd",
      "http://127.0.0.1:8080/private",
      "http://169.254.169.254/latest/meta-data",
      "http://10.0.0.8/internal"
    ]) {
      const { response } = await requestJson(base, "/api/monitors", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          id: `ssrf-product-${Buffer.from(url).toString("hex").slice(0, 12)}`,
          product_id: "ssrf-product",
          type: "http",
          name: "Unsafe target",
          url,
          expected_status: 200
        })
      });
      assert.equal(response.status, 400, url);
    }
  });
});

test("platform health and readiness expose real store readiness", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    const health = await requestJson(base, "/healthz");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);

    const ready = await requestJson(base, "/readyz");
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.ok, true);
    assert.equal(ready.body.checks.store, true);
    assert.equal(ready.body.checks.migrations, true);
  });

  const store = new MemoryStore();
  await store.ready();
  store.readiness = async () => ({ ok: false, checks: { store: false, migrations: false } });
  await withServer({ store, config: config() }, async ({ base }) => {
    const ready = await requestJson(base, "/readyz");
    assert.equal(ready.response.status, 503);
    assert.equal(ready.body.ok, false);
  });
});

test("product API keys are reveal-once, hashed, scoped, rotatable, revocable, and update last_used_at", async () => {
  await withServer({ memory: true, config: config() }, async ({ server, base }) => {
    await createProduct(base, "product-a");
    await createProduct(base, "product-b");

    let result = await requestJson(base, "/api/products/product-a/api-keys", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "runtime", scopes: ["ingest", "read"], expires_at: "2099-01-01T00:00:00.000Z" })
    });
    assert.equal(result.response.status, 201);
    const firstSecret = result.body.secret;
    const firstId = result.body.api_key.id;
    assert.match(firstSecret, /^apr_pk_/);
    assert.equal(result.body.api_key.key_hash, undefined);
    assert.equal(server.store.state.apiKeys[0].key_hash, hashSecret(firstSecret));
    assert.equal(server.store.state.apiKeys[0].secret, undefined);

    result = await requestJson(base, "/api/products/product-a/api-keys", {
      headers: { authorization: `Bearer ${MASTER_KEY}` }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].secret, undefined);
    assert.equal(result.body.items[0].key_hash, undefined);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${firstSecret}` },
      body: JSON.stringify(envelope({ product_id: "product-a" }))
    });
    assert.equal(result.response.status, 200);
    assert.ok(server.store.state.apiKeys[0].last_used_at);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${firstSecret}` },
      body: JSON.stringify(envelope({ product_id: "product-b" }))
    });
    assert.equal(result.response.status, 403);

    result = await requestJson(base, "/api/events", {
      headers: { authorization: `Bearer ${firstSecret}` }
    });
    assert.equal(result.response.status, 200);
    assert.ok(result.body.every((item) => item.product_id === "product-a"));

    result = await requestJson(base, `/api/products/product-a/api-keys/${firstId}/rotate`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({})
    });
    assert.equal(result.response.status, 201);
    const rotatedSecret = result.body.secret;
    assert.notEqual(rotatedSecret, firstSecret);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${firstSecret}` },
      body: JSON.stringify(envelope({ product_id: "product-a" }))
    });
    assert.equal(result.response.status, 401);

    result = await requestJson(base, `/api/products/product-a/api-keys/${result.body?.api_key?.id ?? "missing"}/revoke`, {
      method: "POST",
      headers: adminHeaders(),
      body: "{}"
    });
    if (result.response.status === 404) {
      const keys = await requestJson(base, "/api/products/product-a/api-keys", {
        headers: { authorization: `Bearer ${MASTER_KEY}` }
      });
      const active = keys.body.items.find((item) => !item.revoked_at);
      result = await requestJson(base, `/api/products/product-a/api-keys/${active.id}/revoke`, {
        method: "POST",
        headers: adminHeaders(),
        body: "{}"
      });
    }
    assert.equal(result.response.status, 200);

    result = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rotatedSecret}` },
      body: JSON.stringify(envelope({ product_id: "product-a" }))
    });
    assert.equal(result.response.status, 401);
  });
});

test("compliance scans are independent, product-scoped records", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    await createProduct(base, "scan-a");
    await createProduct(base, "scan-b");

    const createdKey = await requestJson(base, "/api/products/scan-a/api-keys", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "scanner", scopes: ["ingest", "read"] })
    });
    assert.equal(createdKey.response.status, 201);
    const productKey = createdKey.body.secret;

    const scan = {
      product_id: "scan-a",
      environment: "local",
      scanned_at: new Date().toISOString(),
      tool_version: "1.0.0",
      standard_version: "1.0",
      score: 72,
      max_score: 100,
      grade: "B",
      findings: [{ id: "health", status: "detected" }],
      verification: { passed: 1, failed: 0, skipped: 2 }
    };

    let result = await requestJson(base, "/api/compliance-scans", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${productKey}` },
      body: JSON.stringify(scan)
    });
    assert.equal(result.response.status, 201);

    result = await requestJson(base, "/api/compliance-scans", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${productKey}` },
      body: JSON.stringify({ ...scan, product_id: "scan-b" })
    });
    assert.equal(result.response.status, 403);

    result = await requestJson(base, "/api/compliance-scans?product_id=scan-a", {
      headers: { authorization: `Bearer ${productKey}` }
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].product_id, "scan-a");

    result = await requestJson(base, "/api/compliance-scans?product_id=scan-b", {
      headers: { authorization: `Bearer ${productKey}` }
    });
    assert.equal(result.response.status, 403);
  });
});

test("sensitive operations create audit records without secret material", async () => {
  await withServer({ memory: true, config: config() }, async ({ base }) => {
    await createProduct(base, "audit-product");
    const created = await requestJson(base, "/api/products/audit-product/api-keys", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "audited", scopes: ["ingest"] })
    });
    assert.equal(created.response.status, 201);

    const audit = await requestJson(base, "/api/audit-logs", {
      headers: { authorization: `Bearer ${MASTER_KEY}` }
    });
    assert.equal(audit.response.status, 200);
    assert.ok(audit.body.items.some((entry) => entry.action === "api_key.created"));
    assert.doesNotMatch(JSON.stringify(audit.body), new RegExp(created.body.secret));
  });
});
