import assert from "node:assert/strict";
import { retentionCutoff, rollupAndPrune } from "../src/retention.mjs";

const NOW = new Date("2026-07-10T12:00:00.000Z");
const state = {
  products: [],
  events: [event(10), event(1)],
  errors: [error(10), error(1)],
  health: [health(false, 10), health(true, 1)],
  monitorRuns: [monitor(false, 10), monitor(true, 1)],
  alertDeliveries: [delivery(10), delivery(1)],
  dailyAggregates: []
};

assert.equal(retentionCutoff(NOW, 7).toISOString(), "2026-07-03T12:00:00.000Z");
assert.throws(() => retentionCutoff(NOW, 0), /positive/);

const result = rollupAndPrune(state, { rawRetentionDays: 7 }, NOW);
assert.equal(result.state.events.length, 1);
assert.equal(result.state.errors.length, 1);
assert.equal(result.state.health.length, 1);
assert.equal(result.state.monitorRuns.length, 1);
assert.equal(result.state.alertDeliveries.length, 1);
assert.deepEqual(result.deleted, {
  events: 1,
  errors: 1,
  health: 1,
  monitorRuns: 1,
  alertDeliveries: 1
});

assert.equal(result.state.dailyAggregates.length, 1);
assert.deepEqual(result.state.dailyAggregates[0], {
  bucket_date: "2026-06-30",
  product_id: "product-a",
  environment: "production",
  event_count: 1,
  error_count: 1,
  health_ok_count: 0,
  health_failure_count: 1,
  monitor_ok_count: 0,
  monitor_failure_count: 1,
  alert_delivery_count: 1
});

assert.equal(state.events.length, 2, "retention must not mutate the caller state");

console.log("Retention tests OK");

function event(daysAgo) {
  return base(daysAgo, "occurred_at", { payload: { event: "checkout_succeeded" } });
}

function error(daysAgo) {
  return base(daysAgo, "occurred_at", { payload: { name: "Error" } });
}

function health(ok, daysAgo) {
  return base(daysAgo, "occurred_at", { payload: { ok } });
}

function monitor(ok, daysAgo) {
  return base(daysAgo, "checked_at", { ok });
}

function delivery(daysAgo) {
  return base(daysAgo, "delivered_at", {});
}

function base(daysAgo, timestampField, extra) {
  return {
    product_id: "product-a",
    environment: "production",
    [timestampField]: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    ...extra
  };
}
