import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";
import { createIncidentRecord } from "../src/incident-lifecycle.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

function envelope(type, productId, environment, payload, occurredAt = new Date().toISOString()) {
  return {
    schema_version: "1.0",
    type,
    product_id: productId,
    environment,
    release: "r1",
    occurred_at: occurredAt,
    payload
  };
}

async function withServer(store, callback) {
  const server = await createDashboardServer({ store, config: { authRequired: false, workerEnabled: false } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback({ server, base });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function json(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

test("store operational queries isolate product and environment", async () => {
  const store = new MemoryStore();
  await store.ready();
  await store.upsertProduct({ product_id: "state-product", name: "State", owner: "ops", standard_version: "1.0" });
  await store.appendIngestItems([
    envelope("health", "state-product", "production", { ok: false }),
    envelope("health", "state-product", "staging", { ok: true }),
    envelope("event", "state-product", "production", { event: "checkout" }),
    envelope("event", "state-product", "staging", { event: "checkout" }),
    envelope("error", "state-product", "production", { name: "Error", message: "prod" }),
    envelope("release", "state-product", "production", { version: "r1" })
  ]);
  await store.recordMonitorRun({
    monitor_id: "state-product-healthz",
    product_id: "state-product",
    environment: "production",
    severity: "critical",
    ok: false,
    status: "500"
  });
  await store.createIncident(createIncidentRecord({
    product_id: "state-product",
    environment: "production",
    title: "Production down",
    severity: "critical"
  }));

  assert.equal((await store.listHealth({ productId: "state-product", environment: "production" })).length, 1);
  assert.equal((await store.listEvents(20, { productId: "state-product", environment: "production" })).length, 1);
  assert.equal((await store.listErrors(20, { productId: "state-product", environment: "staging" })).length, 0);
  assert.equal((await store.listReleases(20, { productId: "state-product", environment: "production" })).length, 1);
  assert.equal((await store.listMonitorRuns({ productId: "state-product", environment: "production" })).length, 1);
  assert.equal((await store.listIncidents({ productId: "state-product", environment: "staging" })).length, 0);
});

test("operational status API returns unknown without data and never lets staging mask production", async () => {
  const store = new MemoryStore();
  await store.ready();
  await store.upsertProduct({
    product_id: "status-product",
    name: "Status Product",
    owner: "ops",
    standard_version: "1.0",
    environments: [
      { name: "production", url: "https://example.com" },
      { name: "staging", url: "https://staging.example.com" }
    ],
    contract: { public_status: { enabled: true } }
  });

  await withServer(store, async ({ base }) => {
    let result = await json(base, "/api/operational-status?product_id=status-product&environment=production");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.items[0].status, "unknown");

    const now = new Date().toISOString();
    await store.appendIngestItems([
      envelope("health", "status-product", "production", { ok: false }, now),
      envelope("health", "status-product", "production", { ok: false }, now),
      envelope("health", "status-product", "staging", { ok: true }, now)
    ]);

    result = await json(base, "/api/operational-status?product_id=status-product");
    const production = result.body.items.find((item) => item.environment === "production");
    const staging = result.body.items.find((item) => item.environment === "staging");
    assert.equal(production.status, "outage");
    assert.equal(staging.status, "operational");
  });
});

test("critical monitor failures and critical incidents affect the same operational projection", async () => {
  const store = new MemoryStore();
  await store.ready();
  await store.upsertProduct({ product_id: "signals-product", name: "Signals", owner: "ops", standard_version: "1.0" });
  const now = new Date().toISOString();
  await store.appendIngestItems([envelope("health", "signals-product", "production", { ok: true }, now)]);
  for (let index = 0; index < 2; index += 1) {
    await store.recordMonitorRun({
      monitor_id: "signals-product-healthz",
      product_id: "signals-product",
      environment: "production",
      severity: "critical",
      failure_threshold: 2,
      ok: false,
      status: "500",
      checked_at: new Date(Date.now() - index * 1000).toISOString()
    });
  }

  await withServer(store, async ({ base }) => {
    let result = await json(base, "/api/operational-status?product_id=signals-product&environment=production");
    assert.equal(result.body.items[0].status, "outage");

    store.state.monitorRuns = [];
    await store.createIncident(createIncidentRecord({
      product_id: "signals-product",
      environment: "production",
      title: "Critical incident",
      severity: "critical"
    }));
    result = await json(base, "/api/operational-status?product_id=signals-product&environment=production");
    assert.equal(result.body.items[0].status, "outage");
  });
});
