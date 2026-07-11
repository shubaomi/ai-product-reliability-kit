import assert from "node:assert/strict";
import test from "node:test";
import { createDashboardServer } from "../server.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

async function withServer(store, callback) {
  const server = await createDashboardServer({ store, config: { authRequired: false, workerEnabled: false, rawRetentionDays: 7 } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback({ server, base });
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function call(base, pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { response, body: await response.json().catch(() => null) };
}

async function seededStore() {
  const store = new MemoryStore();
  await store.ready();
  await store.upsertProduct({
    product_id: "operations-product",
    name: "Operations Product",
    owner: "owner@example.com",
    standard_version: "1.0",
    environments: [{ name: "production", url: "https://example.com" }],
    critical_journeys: [{ id: "checkout", name: "Checkout", success_event: "checkout_completed" }],
    contract: {
      public_status: { enabled: true },
      features: ["Checkout"],
      architecture: { runtime: "Node.js" }
    }
  });
  await store.appendIngestItems([{
    schema_version: "1.0",
    type: "health",
    product_id: "operations-product",
    environment: "production",
    release: "r1",
    occurred_at: new Date().toISOString(),
    payload: { ok: true }
  }]);
  return store;
}

test("incident API persists owner, timeline, linked alerts, and recovery note", async () => {
  const store = await seededStore();
  await withServer(store, async ({ base }) => {
    let result = await call(base, "/api/incidents", {
      method: "POST",
      body: {
        product_id: "operations-product",
        environment: "production",
        title: "Checkout unavailable",
        severity: "critical",
        owner: "owner@example.com"
      }
    });
    assert.equal(result.response.status, 201);
    const incidentId = result.body.incident.id;

    result = await call(base, `/api/incidents/${incidentId}/acknowledge`, {
      method: "POST",
      body: { actor: "owner@example.com" }
    });
    assert.equal(result.body.incident.status, "acknowledged");

    result = await call(base, `/api/incidents/${incidentId}/link-alerts`, {
      method: "POST",
      body: { actor: "owner@example.com", alert_ids: ["alert-1"] }
    });
    assert.deepEqual(result.body.incident.alert_ids, ["alert-1"]);

    result = await call(base, `/api/incidents/${incidentId}/resolve`, {
      method: "POST",
      body: { actor: "owner@example.com", recovery_note: "Rolled back and verified checkout." }
    });
    assert.equal(result.body.incident.status, "resolved");
    assert.match(result.body.incident.recovery_note, /Rolled back/);
    assert.ok(result.body.incident.timeline.length >= 4);
  });
});

test("maintenance, retention, product detail, passport, and explicit public status endpoints use store data", async () => {
  const store = await seededStore();
  const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
  store.state.events.push({ product_id: "operations-product", environment: "production", occurred_at: old, payload: { event: "old" } });
  await store.createComplianceScan({
    product_id: "operations-product",
    environment: "local",
    scanned_at: new Date().toISOString(),
    tool_version: "1.0.0",
    standard_version: "1.0",
    score: 80,
    max_score: 100,
    grade: "B",
    findings: [],
    verification: {}
  });
  await store.appendStatusPages([{
    product_id: "operations-product",
    public_slug: "operations",
    public_summary: "Operating normally.",
    components: [{ name: "API", status: "operational" }],
    title: "Operations",
    body: "internal-only",
    generated_at: new Date().toISOString()
  }]);

  await withServer(store, async ({ base }) => {
    let result = await call(base, "/api/maintenance-windows", {
      method: "POST",
      body: {
        product_id: "operations-product",
        environment: "production",
        name: "Deploy",
        starts_at: new Date(Date.now() - 1000).toISOString(),
        ends_at: new Date(Date.now() + 60_000).toISOString()
      }
    });
    assert.equal(result.response.status, 201);

    result = await call(base, "/api/retention/run", { method: "POST", body: {} });
    assert.equal(result.response.status, 200);
    assert.equal(result.body.deleted.events, 1);
    assert.equal(store.state.dailyAggregates.length, 1);

    result = await call(base, "/api/products/operations-product/detail?environment=production");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.environment, "production");
    assert.equal(result.body.status.status, "operational");

    result = await call(base, "/api/system-passports/operations-product?environment=production");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.product_id, "operations-product");

    result = await call(base, "/api/status");
    assert.equal(result.response.status, 200);
    assert.equal(result.body.products.length, 1);
    assert.equal(result.body.products[0].slug, "operations");
    assert.equal(JSON.stringify(result.body).includes("internal-only"), false);
  });
});

test("server shutdown waits for an in-flight request", async () => {
  const store = await seededStore();
  let release;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const releasePromise = new Promise((resolve) => { release = resolve; });
  store.summarize = async () => {
    started();
    await releasePromise;
    return { status: "operational" };
  };

  await withServer(store, async ({ server, base }) => {
    const request = fetch(`${base}/api/summary`);
    await startedPromise;
    let shutdownComplete = false;
    const shutdown = server.shutdown().then(() => { shutdownComplete = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(shutdownComplete, false);
    release();
    assert.equal((await request).status, 200);
    await shutdown;
    assert.equal(shutdownComplete, true);
  });
});

test("manual scheduler run respects the shared scheduler lease", async () => {
  const store = await seededStore();
  let releaseLease;
  let leaseEntered;
  const entered = new Promise((resolve) => { leaseEntered = resolve; });
  const heldLease = store.withSchedulerLease(async () => {
    leaseEntered();
    await new Promise((resolve) => { releaseLease = resolve; });
  });
  await entered;

  try {
    await withServer(store, async ({ base }) => {
      const result = await call(base, "/api/scheduler/run-once", { method: "POST", body: {} });
      assert.equal(result.response.status, 409);
      assert.match(result.body.error, /scheduler.*running/i);
    });
  } finally {
    releaseLease();
    await heldLease;
  }
});

test("operational mutation APIs reject invalid input and preserve client-visible error semantics", async () => {
  const store = await seededStore();
  await withServer(store, async ({ base }) => {
    let result = await call(base, "/api/monitors", {
      method: "POST",
      body: {
        id: "operations-product-checkout-freshness",
        product_id: "operations-product",
        environment: "production",
        type: "event-freshness",
        name: "Checkout freshness",
        event: "checkout_completed",
        window_minutes: 0,
        min_count: 1
      }
    });
    assert.equal(result.response.status, 400);

    result = await call(base, "/api/alerts", {
      method: "POST",
      body: {
        id: "operations-product-error-spike",
        product_id: "operations-product",
        environment: "production",
        type: "error_spike",
        name: "Error spike",
        window_seconds: -1,
        min_samples: "5",
        multiplier: 0,
        cooldown_seconds: 0,
        recovery_threshold: 0
      }
    });
    assert.equal(result.response.status, 400);

    result = await call(base, "/api/monitors", {
      method: "POST",
      body: {
        id: "missing-product-freshness",
        product_id: "missing-product",
        environment: "production",
        type: "event-freshness",
        name: "Missing product freshness",
        event: "checkout_completed",
        window_minutes: 30,
        min_count: 1
      }
    });
    assert.equal(result.response.status, 404);

    result = await call(base, "/api/status-pages", {
      method: "POST",
      body: {
        product_id: "operations-product",
        public_slug: "not a valid public slug",
        title: "Operations",
        components: []
      }
    });
    assert.equal(result.response.status, 400);

    result = await call(base, "/api/incidents", {
      method: "POST",
      body: { product_id: "operations-product", environment: "production", severity: "high" }
    });
    assert.equal(result.response.status, 400);

    const created = await call(base, "/api/incidents", {
      method: "POST",
      body: { product_id: "operations-product", environment: "production", title: "Checkout unavailable", severity: "high" }
    });
    assert.equal(created.response.status, 201);
    const resolved = await call(base, `/api/incidents/${created.body.incident.id}/resolve`, {
      method: "POST",
      body: { recovery_note: "Recovered checkout", actor: "operator" }
    });
    assert.equal(resolved.response.status, 200);
    result = await call(base, `/api/incidents/${created.body.incident.id}/acknowledge`, {
      method: "POST",
      body: { actor: "operator" }
    });
    assert.equal(result.response.status, 409);
  });
});
