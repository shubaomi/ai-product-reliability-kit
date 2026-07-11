import assert from "node:assert/strict";
import test from "node:test";
import { runSchedulerOnce } from "../src/scheduler.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

const NOW = new Date("2026-07-10T12:00:00.000Z");

async function productStore(productId = "scheduler-v2") {
  const store = new MemoryStore();
  await store.ready();
  await store.upsertProduct({ product_id: productId, name: productId, owner: "ops", standard_version: "1.0" });
  return store;
}

test("scheduler honors per-monitor cadence and event environment", async () => {
  const store = await productStore();
  await store.appendIngestItems([event("scheduler-v2", "production", "checkout_completed")]);
  await store.appendMonitors([
    {
      id: "scheduler-v2-slow",
      product_id: "scheduler-v2",
      environment: "production",
      type: "http",
      name: "Slow",
      url: "https://safe.example.test/healthz",
      interval_seconds: 300,
      expected_status: 200
    },
    {
      id: "scheduler-v2-staging-journey",
      product_id: "scheduler-v2",
      environment: "staging",
      type: "event-freshness",
      name: "Staging journey",
      event: "checkout_completed",
      window_minutes: 60,
      min_count: 1,
      interval_seconds: 60
    }
  ]);
  await store.recordMonitorRun({
    monitor_id: "scheduler-v2-slow",
    product_id: "scheduler-v2",
    environment: "production",
    ok: true,
    status: "200",
    checked_at: new Date(NOW.getTime() - 30_000).toISOString()
  });

  let fetchCalls = 0;
  const result = await runSchedulerOnce(store, schedulerConfig(), {
    now: NOW,
    fetchImpl: async () => { fetchCalls += 1; return { status: 200, ok: true, headers: new Headers() }; }
  });

  assert.equal(result.checked, 1);
  assert.equal(result.skipped, 1);
  assert.equal(fetchCalls, 0);
  assert.equal(result.results[0].environment, "staging");
  assert.equal(result.results[0].ok, false, "production events cannot satisfy a staging monitor");
});

test("scheduler revalidates SSRF immediately before fetch", async () => {
  const store = await productStore("unsafe-product");
  await store.appendMonitors([{
    id: "unsafe-product-metadata",
    product_id: "unsafe-product",
    environment: "production",
    type: "http",
    name: "Metadata",
    url: "http://169.254.169.254/latest/meta-data",
    interval_seconds: 60
  }]);
  let fetchCalls = 0;
  const result = await runSchedulerOnce(store, schedulerConfig(), {
    now: NOW,
    fetchImpl: async () => { fetchCalls += 1; return { status: 200, ok: true, headers: new Headers() }; }
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.results[0].status, "unsafe_url");
  assert.equal(result.results[0].ok, false);
});

test("scheduler pins the DNS answer it validated instead of resolving the hostname again", async () => {
  const store = await productStore("rebind-product");
  await store.appendMonitors([{
    id: "rebind-product-healthz",
    product_id: "rebind-product",
    environment: "production",
    type: "http",
    name: "Rebinding target",
    url: "https://rebind.example.test/healthz",
    interval_seconds: 60,
    expected_status: 200
  }]);
  let dnsCalls = 0;
  let requestTarget;
  const result = await runSchedulerOnce(store, { ...schedulerConfig(), allowedMonitorHosts: [] }, {
    now: NOW,
    dnsLookup: async () => {
      dnsCalls += 1;
      return [{ address: dnsCalls === 1 ? "93.184.216.34" : "169.254.169.254", family: 4 }];
    },
    requestImpl: async (target) => {
      requestTarget = target;
      return { status: 200 };
    }
  });

  assert.equal(result.results[0].ok, true);
  assert.equal(dnsCalls, 1, "the request path must not perform another DNS lookup");
  const pinned = await new Promise((resolve, reject) => requestTarget.lookup("rebind.example.test", {}, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  }));
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
});

test("structured availability alert opens at threshold, deduplicates, acknowledges, and resolves with one recovery", async () => {
  const store = await productStore("alert-v2");
  await store.appendMonitors([{
    id: "alert-v2-healthz",
    product_id: "alert-v2",
    environment: "production",
    type: "http",
    name: "Health",
    url: "https://safe.example.test/healthz",
    interval_seconds: 1,
    expected_status: 200,
    severity: "critical"
  }]);
  await store.appendAlerts([{
    id: "alert-v2-healthz-availability",
    product_id: "alert-v2",
    environment: "production",
    type: "availability_failure",
    monitor_id: "alert-v2-healthz",
    name: "Health failing",
    severity: "critical",
    consecutive_failures: 2,
    cooldown_seconds: 300,
    recovery_threshold: 2
  }]);

  const responses = [500, 500, 500, 200, 200];
  for (let index = 0; index < responses.length; index += 1) {
    await runSchedulerOnce(store, schedulerConfig(), {
      now: new Date(NOW.getTime() + index * 2_000),
      fetchImpl: async () => ({ status: responses[index], ok: responses[index] === 200, headers: new Headers() })
    });
    if (index === 1) {
      const opened = await store.listAlertInstances({ productId: "alert-v2", environment: "production" });
      assert.equal(opened[0].status, "open");
      await store.acknowledgeAlertInstance(opened[0].id, { actor: "operator@example.com", now: new Date(NOW.getTime() + 2_500) });
    }
  }

  const instances = await store.listAlertInstances({ productId: "alert-v2", environment: "production" });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].status, "resolved");
  const deliveries = store.state.alertDeliveries.filter((item) => item.alert_id === "alert-v2-healthz-availability");
  assert.equal(deliveries.filter((item) => item.notification_type === "alert").length, 1);
  assert.equal(deliveries.filter((item) => item.notification_type === "recovery").length, 1);
});

test("active maintenance window suppresses monitor execution", async () => {
  const store = await productStore("maintenance-product");
  await store.appendMonitors([{
    id: "maintenance-product-healthz",
    product_id: "maintenance-product",
    environment: "production",
    type: "http",
    name: "Health",
    url: "https://safe.example.test/healthz",
    interval_seconds: 60
  }]);
  await store.createMaintenanceWindow({
    product_id: "maintenance-product",
    environment: "production",
    name: "Deploy",
    starts_at: new Date(NOW.getTime() - 60_000).toISOString(),
    ends_at: new Date(NOW.getTime() + 60_000).toISOString()
  });
  let fetchCalls = 0;
  const result = await runSchedulerOnce(store, schedulerConfig(), {
    now: NOW,
    fetchImpl: async () => { fetchCalls += 1; return { status: 200, ok: true, headers: new Headers() }; }
  });
  assert.equal(fetchCalls, 0);
  assert.equal(result.checked, 0);
  assert.equal(result.maintenance_skipped, 1);
});

function schedulerConfig() {
  return {
    allowedMonitorHosts: ["safe.example.test"],
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    alertWebhookUrl: null,
    alertFeishuWebhookUrl: null,
    workerIntervalMs: 1000
  };
}

function event(productId, environment, name) {
  return {
    schema_version: "1.0",
    type: "event",
    product_id: productId,
    environment,
    release: "r1",
    occurred_at: new Date(NOW.getTime() - 30_000).toISOString(),
    payload: { event: name }
  };
}
