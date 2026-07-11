import assert from "node:assert/strict";
import { MemoryStore } from "../src/stores/memory-store.mjs";
import { runSchedulerOnce } from "../src/scheduler.mjs";

const store = new MemoryStore();
await store.ready();
await store.upsertProduct({
  product_id: "scheduler-product",
  name: "Scheduler Product",
  owner: "owner@example.com",
  standard_version: "1.0"
});
await store.appendMonitors([
  {
    id: "scheduler-product-healthz",
    product_id: "scheduler-product",
    type: "http",
    name: "Health",
    url: "https://example.test/healthz",
    expected_status: 200,
    severity: "critical"
  },
  {
    id: "scheduler-product-core-journey",
    product_id: "scheduler-product",
    type: "event-freshness",
    name: "Core Journey",
    event: "core_completed",
    window_minutes: 60,
    min_count: 1,
    severity: "high"
  },
  {
    id: "scheduler-product-dashboard-ingest",
    product_id: "scheduler-product",
    type: "collector",
    name: "Dashboard collector",
    url: "http://127.0.0.1:8787/api/ingest",
    expected_status: 200,
    severity: "medium"
  }
]);
await store.appendAlerts([
  {
    id: "scheduler-product-health-down",
    product_id: "scheduler-product",
    environment: "production",
    type: "availability_failure",
    monitor_id: "scheduler-product-healthz",
    name: "Health down",
    consecutive_failures: 1,
    severity: "critical",
    action: "Investigate health"
  },
  {
    id: "scheduler-product-journey-drop",
    product_id: "scheduler-product",
    environment: "production",
    type: "availability_failure",
    monitor_id: "scheduler-product-core-journey",
    name: "Journey freshness failed",
    consecutive_failures: 1,
    severity: "high",
    action: "Investigate events"
  }
]);

const result = await runSchedulerOnce(store, {
  workerIntervalMs: 60_000,
  allowedMonitorHosts: ["example.test", "127.0.0.1"],
  dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
  alertWebhookUrl: null,
  alertFeishuWebhookUrl: null
}, {
  fetchImpl: async (url) => ({ status: String(url).endsWith("/api/status") ? 200 : 500 })
});

assert.equal(result.checked, 3);
assert.equal(result.failed, 2);
assert.equal(store.state.monitorRuns.length, 3);
assert.equal(store.state.alertDeliveries.length, 2);
assert.equal(store.state.monitorRuns.at(-1).details.url, "http://127.0.0.1:8787/api/status");

console.log("Scheduler tests OK");
