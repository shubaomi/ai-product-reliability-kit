import assert from "node:assert/strict";
import {
  acknowledgeAlert,
  evaluateAlertRule,
  isMonitorDue,
  transitionAlert
} from "../src/alert-rules.mjs";

const NOW = new Date("2026-07-10T12:00:00.000Z");

assert.throws(() => evaluateAlertRule({ rule: baseRule("custom_dsl"), now: NOW }), /Unsupported alert rule type/);

const oneFailure = evaluateAlertRule({
  rule: { ...baseRule("availability_failure"), consecutive_failures: 2, monitor_id: "api" },
  monitorRuns: [run(false, 1)],
  now: NOW
});
assert.equal(oneFailure.active, false);

const twoFailures = evaluateAlertRule({
  rule: { ...baseRule("availability_failure"), consecutive_failures: 2, monitor_id: "api" },
  monitorRuns: [run(false, 2), run(false, 1)],
  now: NOW
});
assert.equal(twoFailures.active, true);
assert.equal(twoFailures.dedupKey, "product-a:production:availability_failure:api");

const maintenance = evaluateAlertRule({
  rule: { ...baseRule("availability_failure"), consecutive_failures: 1, monitor_id: "api" },
  monitorRuns: [run(false, 1)],
  maintenanceWindows: [{ starts_at: ago(5), ends_at: after(5), environment: "production" }],
  now: NOW
});
assert.equal(maintenance.suppressed, true);
assert.equal(maintenance.active, false);

assert.equal(evaluateAlertRule({
  rule: { ...baseRule("telemetry_stale"), stale_after_seconds: 60 },
  telemetry: [{ product_id: "product-a", environment: "production", occurred_at: ago(2) }],
  now: NOW
}).active, true);

assert.equal(evaluateAlertRule({
  rule: { ...baseRule("error_spike"), window_seconds: 300, min_samples: 5, multiplier: 2 },
  errors: Array.from({ length: 6 }, (_, index) => ({ product_id: "product-a", environment: "production", occurred_at: ago(index / 10) })),
  baseline: { count: 2 },
  now: NOW
}).active, true);

assert.equal(evaluateAlertRule({
  rule: { ...baseRule("journey_drop"), min_samples: 5, drop_percent: 30 },
  current: { count: 5 },
  baseline: { count: 10 },
  now: NOW
}).active, true);

assert.equal(isMonitorDue({ interval_seconds: 60 }, ago(0.5), NOW), false);
assert.equal(isMonitorDue({ interval_seconds: 60 }, ago(2), NOW), true);
assert.equal(isMonitorDue({ interval_seconds: 300 }, ago(2), NOW), false);

let alert = transitionAlert({ evaluation: twoFailures, existing: null, now: NOW, cooldownSeconds: 300, recoveryThreshold: 2 });
assert.equal(alert.status, "open");
assert.equal(alert.notify, true);

alert = transitionAlert({ evaluation: twoFailures, existing: alert.alert, now: new Date(NOW.getTime() + 60_000), cooldownSeconds: 300, recoveryThreshold: 2 });
assert.equal(alert.status, "open");
assert.equal(alert.notify, false, "same fault must not notify every minute");

const acknowledged = acknowledgeAlert(alert.alert, { actor: "operator@example.com", now: new Date(NOW.getTime() + 90_000) });
assert.equal(acknowledged.status, "acknowledged");

const recovered = { ...twoFailures, active: false, reason: "monitor recovered" };
alert = transitionAlert({ evaluation: recovered, existing: acknowledged, now: new Date(NOW.getTime() + 120_000), recoveryThreshold: 2 });
assert.equal(alert.status, "acknowledged");
assert.equal(alert.notify, false);

alert = transitionAlert({ evaluation: recovered, existing: alert.alert, now: new Date(NOW.getTime() + 180_000), recoveryThreshold: 2 });
assert.equal(alert.status, "resolved");
assert.equal(alert.notify, true);
assert.equal(alert.notificationType, "recovery");

console.log("Alert rule tests OK");

function baseRule(type) {
  return {
    id: `${type}-rule`,
    type,
    product_id: "product-a",
    environment: "production"
  };
}

function run(ok, minutesAgo) {
  return {
    product_id: "product-a",
    environment: "production",
    monitor_id: "api",
    checked_at: ago(minutesAgo),
    ok
  };
}

function ago(minutes) {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function after(minutes) {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}
