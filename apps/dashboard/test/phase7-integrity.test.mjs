import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

const MASTER_KEY = "m".repeat(40);

test("configured critical monitor without a run and active structured alerts prevent operational state", async () => {
  const store = await seededStore("status-integrity");
  await store.appendMonitors([{
    id: "status-integrity-production-readiness",
    product_id: "status-integrity",
    environment: "production",
    name: "Production readiness",
    type: "http",
    url: "https://example.com/readyz",
    severity: "critical",
    enabled: true
  }]);

  await withServer(store, { authRequired: false }, async (base) => {
    let status = await getJson(base, "/api/operational-status?product_id=status-integrity&environment=production");
    assert.equal(status.items[0].status, "unknown");
    assert.ok(status.items[0].reasons.some((reason) => reason.code === "monitor_unknown"));

    await store.recordMonitorRun({
      monitor_id: "status-integrity-production-readiness",
      product_id: "status-integrity",
      environment: "production",
      ok: true,
      status: "200",
      severity: "critical",
      checked_at: new Date().toISOString()
    });
    await store.appendAlerts([{
      id: "stale-rule",
      product_id: "status-integrity",
      environment: "production",
      name: "Telemetry stale",
      type: "telemetry_stale",
      enabled: true
    }]);
    await store.upsertAlertInstance({
      dedup_key: "status-integrity:production:telemetry_stale:telemetry",
      rule_id: "stale-rule",
      rule_type: "telemetry_stale",
      product_id: "status-integrity",
      environment: "production",
      name: "Telemetry stale",
      severity: "high",
      status: "open",
      opened_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    });
    status = await getJson(base, "/api/operational-status?product_id=status-integrity&environment=production");
    assert.equal(status.items[0].status, "degraded");
    assert.ok(status.items[0].reasons.some((reason) => reason.code === "active_alert"));
  });
});

test("all telemetry types deduplicate by product, environment, and idempotency key", async () => {
  const store = await seededStore("dedup-integrity");
  const occurredAt = new Date().toISOString();
  const event = envelope("event", "production", "shared-key", { event: "checkout_completed", properties: {} }, occurredAt);
  const stagingEvent = envelope("event", "staging", "shared-key", { event: "checkout_completed", properties: {} }, occurredAt);
  const error = envelope("error", "production", "error-key", { name: "Error", message: "boom" }, occurredAt);
  const health = envelope("health", "production", "health-key", { ok: false, checks: { database: false } }, occurredAt);

  const first = await store.appendIngestItems([event, stagingEvent, error, health]);
  const replay = await store.appendIngestItems([event, stagingEvent, error, health]);
  assert.equal(first.accepted, 4);
  assert.equal(replay.accepted, 0);
  assert.equal((await store.listEvents(20, { productId: "dedup-integrity", environment: "production" })).length, 1);
  assert.equal((await store.listEvents(20, { productId: "dedup-integrity", environment: "staging" })).length, 1);
  assert.equal((await store.listErrors(20, { productId: "dedup-integrity", environment: "production" })).length, 1);
  assert.equal((await store.listHealth({ productId: "dedup-integrity", environment: "production" })).length, 2, "seed health plus one deduplicated failing report");
  await assert.rejects(
    () => store.appendIngestItems([{ ...event, type: "health", payload: { ok: true, checks: {} } }]),
    (error) => error.status === 409 && /telemetry type event/.test(error.message)
  );

  const atomicStore = await seededStore("dedup-integrity");
  await assert.rejects(
    () => atomicStore.appendIngestItems([event, { ...event, type: "health", payload: { ok: true, checks: {} } }]),
    (error) => error.status === 409
  );
  assert.equal((await atomicStore.listEvents(20, { productId: "dedup-integrity", environment: "production" })).length, 0, "a conflicting batch must not partially persist");
});

test("product key cannot see fleet status or smuggle another product through a product envelope", async () => {
  const store = new MemoryStore();
  await withServer(store, { authRequired: true, masterApiKey: MASTER_KEY, sessionSecret: "s".repeat(40) }, async (base) => {
    await createProduct(base, "scope-a");
    await createProduct(base, "scope-b");
    const keyResponse = await requestJson(base, "/api/products/scope-a/api-keys", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "scope-a server", scopes: ["ingest", "read"] })
    });
    assert.equal(keyResponse.response.status, 201);
    const productHeaders = { "content-type": "application/json", authorization: `Bearer ${keyResponse.body.secret}` };

    const status = await requestJson(base, "/api/operational-status", { headers: productHeaders });
    assert.equal(status.response.status, 200);
    assert.deepEqual([...new Set(status.body.items.map((item) => item.product_id))], ["scope-a"]);

    const ingest = await requestJson(base, "/api/ingest", {
      method: "POST",
      headers: productHeaders,
      body: JSON.stringify({
        schema_version: "1.1",
        type: "product",
        product_id: "scope-a",
        environment: "production",
        release: "r1",
        occurred_at: new Date().toISOString(),
        idempotency_key: "product-smuggle",
        payload: {
          contract: {
            standard_version: "1.1",
            product: { id: "scope-b", name: "Compromised B", owner: "attacker@example.com" },
            environments: [{ name: "production", url: "https://example.com" }],
            critical_journeys: []
          }
        }
      })
    });
    assert.equal(ingest.response.status, 400);
    assert.equal((await store.getProduct("scope-b")).name, "scope-b");
  });
});

test("monitor, alert, and public slug ownership collisions fail atomically", async () => {
  const store = await seededStore("owner-a");
  await store.upsertProduct(product("owner-b"));
  await store.appendMonitors([{ id: "shared-monitor", product_id: "owner-a", environment: "production", name: "A", type: "http", url: "https://example.com" }]);
  await assert.rejects(
    () => store.recordMonitorRun({ monitor_id: "shared-monitor", product_id: "owner-b", environment: "production", ok: true, status: "200" }),
    (error) => error.status === 409
  );
  await assert.rejects(
    () => store.appendMonitors([{ id: "shared-monitor", product_id: "owner-b", environment: "staging", name: "B", type: "http", url: "https://example.org" }]),
    (error) => error.status === 409
  );
  assert.equal((await store.listMonitors({ productId: "owner-a", environment: "production" })).length, 1);
  assert.equal((await store.listMonitors({ productId: "owner-b" })).length, 0);

  await store.appendAlerts([{ id: "shared-alert", product_id: "owner-a", environment: "production", name: "A", type: "telemetry_stale" }]);
  await assert.rejects(
    () => store.appendAlerts([{ id: "shared-alert", product_id: "owner-b", environment: "staging", name: "B", type: "error_spike" }]),
    (error) => error.status === 409
  );
  assert.equal((await store.listAlerts({ productId: "owner-a" })).length, 1);

  await store.upsertAlertInstance({
    rule_id: "shared-alert",
    rule_type: "telemetry_stale",
    product_id: "owner-a",
    environment: "production",
    dedup_key: "owner-a:production:globally-shared-dedup",
    name: "A",
    status: "open",
    opened_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString()
  });
  await assert.rejects(
    () => store.upsertAlertInstance({
      rule_id: "other-alert",
      rule_type: "error_spike",
      product_id: "owner-b",
      environment: "staging",
      dedup_key: "owner-a:production:globally-shared-dedup",
      name: "B",
      status: "open",
      opened_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString()
    }),
    (error) => error.status === 409
  );

  await assert.rejects(
    () => store.appendStatusPages([{ product_id: "owner-a", public_slug: "owner-b", title: "Impersonation", body: "", generated_at: new Date().toISOString() }]),
    (error) => error.status === 409
  );
  await store.appendStatusPages([{ product_id: "owner-a", public_slug: "shared-status", title: "A", body: "A", generated_at: new Date().toISOString() }]);
  await assert.rejects(
    () => store.appendStatusPages([{ product_id: "owner-b", public_slug: "shared-status", title: "B", body: "B", generated_at: new Date().toISOString() }]),
    (error) => error.status === 409
  );
  assert.equal((await store.getStatusPage("shared-status")).product_id, "owner-a");

  const futureStore = await seededStore("slug-owner");
  await futureStore.appendStatusPages([{ product_id: "slug-owner", public_slug: "future-product", title: "Future", body: "", generated_at: new Date().toISOString() }]);
  await assert.rejects(() => futureStore.upsertProduct(product("future-product")), (error) => error.status === 409);
});

async function seededStore(productId) {
  const store = new MemoryStore();
  await store.upsertProduct(product(productId));
  await store.appendIngestItems([envelope("health", "production", `${productId}-seed-health`, { ok: true, checks: {} }, new Date().toISOString(), productId)]);
  return store;
}

function product(productId) {
  return {
    product_id: productId,
    name: productId,
    owner: "owner@example.com",
    standard_version: "1.1",
    environments: [{ name: "production", url: "https://example.com" }, { name: "staging", url: "https://staging.example.com" }],
    critical_journeys: [],
    contract: {}
  };
}

function envelope(type, environment, idempotencyKey, payload, occurredAt = new Date().toISOString(), productId = "dedup-integrity") {
  return {
    schema_version: "1.1",
    type,
    product_id: productId,
    environment,
    release: "r1",
    occurred_at: occurredAt,
    idempotency_key: idempotencyKey,
    payload
  };
}

async function withServer(store, config, callback) {
  const server = await createDashboardServer({ store, config: { workerEnabled: false, ...config } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await callback(base); } finally { await server.shutdown(); }
}

async function createProduct(base, productId) {
  const result = await requestJson(base, "/api/products", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify(product(productId))
  });
  assert.equal(result.response.status, 200);
}

function adminHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${MASTER_KEY}` };
}

async function getJson(base, pathname) {
  const response = await fetch(`${base}${pathname}`);
  assert.equal(response.ok, true);
  return response.json();
}

async function requestJson(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  return { response, body: await response.json().catch(() => null) };
}
