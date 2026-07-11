const RAW_COLLECTIONS = Object.freeze({
  events: { timestamp: "occurred_at", increment: "event_count" },
  errors: { timestamp: "occurred_at", increment: "error_count" },
  health: { timestamp: "occurred_at", increment: (item) => item.payload?.ok === true ? "health_ok_count" : "health_failure_count" },
  monitorRuns: { timestamp: "checked_at", increment: (item) => item.ok === true ? "monitor_ok_count" : "monitor_failure_count" },
  alertDeliveries: { timestamp: "delivered_at", increment: "alert_delivery_count" }
});

const COUNT_FIELDS = Object.freeze([
  "event_count",
  "error_count",
  "health_ok_count",
  "health_failure_count",
  "monitor_ok_count",
  "monitor_failure_count",
  "alert_delivery_count"
]);

export function retentionCutoff(now = new Date(), rawRetentionDays) {
  const days = Number(rawRetentionDays);
  if (!Number.isFinite(days) || days <= 0) throw new Error("rawRetentionDays must be a positive number");
  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) throw new Error("Invalid retention clock");
  return new Date(nowMs - days * 86_400_000);
}

export function rollupAndPrune(state, { rawRetentionDays }, now = new Date()) {
  const cutoff = retentionCutoff(now, rawRetentionDays);
  const cutoffMs = cutoff.getTime();
  const nextState = { ...state };
  const deleted = {};
  const aggregates = seedAggregates(state.dailyAggregates ?? []);

  for (const [collectionName, definition] of Object.entries(RAW_COLLECTIONS)) {
    const source = Array.isArray(state[collectionName]) ? state[collectionName] : [];
    const retained = [];
    let deletedCount = 0;
    for (const item of source) {
      const timestamp = toMillis(item[definition.timestamp]);
      if (!Number.isFinite(timestamp) || timestamp >= cutoffMs) {
        retained.push(item);
        continue;
      }
      const aggregate = aggregateFor(aggregates, item, timestamp);
      const field = typeof definition.increment === "function" ? definition.increment(item) : definition.increment;
      aggregate[field] += 1;
      deletedCount += 1;
    }
    nextState[collectionName] = retained;
    deleted[collectionName] = deletedCount;
  }

  nextState.dailyAggregates = [...aggregates.values()].sort((left, right) => (
    left.bucket_date.localeCompare(right.bucket_date)
    || left.product_id.localeCompare(right.product_id)
    || left.environment.localeCompare(right.environment)
  ));
  return { state: nextState, deleted, cutoff: cutoff.toISOString() };
}

function seedAggregates(existing) {
  const result = new Map();
  for (const item of existing) {
    const normalized = emptyAggregate(item.bucket_date, item.product_id, item.environment);
    for (const field of COUNT_FIELDS) normalized[field] = safeCount(item[field]);
    result.set(keyOf(normalized), normalized);
  }
  return result;
}

function aggregateFor(aggregates, item, timestamp) {
  const bucketDate = new Date(timestamp).toISOString().slice(0, 10);
  const candidate = emptyAggregate(bucketDate, String(item.product_id ?? "unknown"), String(item.environment ?? "unknown"));
  const key = keyOf(candidate);
  if (!aggregates.has(key)) aggregates.set(key, candidate);
  return aggregates.get(key);
}

function emptyAggregate(bucketDate, productId, environment) {
  return {
    bucket_date: bucketDate,
    product_id: productId,
    environment,
    event_count: 0,
    error_count: 0,
    health_ok_count: 0,
    health_failure_count: 0,
    monitor_ok_count: 0,
    monitor_failure_count: 0,
    alert_delivery_count: 0
  };
}

function keyOf(item) {
  return `${item.bucket_date}\u0000${item.product_id}\u0000${item.environment}`;
}

function safeCount(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}
