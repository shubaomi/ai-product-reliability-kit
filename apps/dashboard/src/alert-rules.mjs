const SUPPORTED_RULE_TYPES = new Set([
  "availability_failure",
  "telemetry_stale",
  "error_spike",
  "journey_drop"
]);

export function evaluateAlertRule({
  rule,
  monitorRuns = [],
  telemetry = [],
  errors = [],
  current,
  baseline,
  maintenanceWindows = [],
  now = new Date()
}) {
  if (!SUPPORTED_RULE_TYPES.has(rule?.type)) {
    throw new Error(`Unsupported alert rule type: ${rule?.type ?? "missing"}`);
  }

  const dedupKey = alertDedupKey(rule);
  if (isInMaintenance(rule, maintenanceWindows, now)) {
    return { active: false, suppressed: true, reason: "maintenance window", dedupKey };
  }

  if (rule.type === "availability_failure") {
    const runs = newestFirst(monitorRuns.filter((item) => (
      matches(item, rule)
      && (!rule.monitor_id || (item.monitor_id ?? item.id) === rule.monitor_id)
    )), "checked_at");
    const failures = countConsecutive(runs, (item) => item.ok === false);
    const threshold = positiveInteger(rule.consecutive_failures, 2);
    return {
      active: failures >= threshold,
      suppressed: false,
      reason: `${failures}/${threshold} consecutive monitor failures`,
      dedupKey,
      evidence: { failures, threshold }
    };
  }

  if (rule.type === "telemetry_stale") {
    const latest = newestFirst(telemetry.filter((item) => matches(item, rule)), "occurred_at")[0];
    const thresholdMs = positiveNumber(rule.stale_after_seconds ?? rule.window_seconds, 300) * 1000;
    const ageMs = latest ? toMillis(now) - toMillis(latest.occurred_at) : Number.POSITIVE_INFINITY;
    return {
      active: !latest || !Number.isFinite(ageMs) || ageMs > thresholdMs,
      suppressed: false,
      reason: latest ? `telemetry age ${Math.max(0, ageMs)}ms exceeds ${thresholdMs}ms` : "no telemetry received",
      dedupKey,
      evidence: { latest_at: latest?.occurred_at ?? null, age_ms: Number.isFinite(ageMs) ? ageMs : null, threshold_ms: thresholdMs }
    };
  }

  if (rule.type === "error_spike") {
    const windowMs = positiveNumber(rule.window_seconds, 300) * 1000;
    const cutoff = toMillis(now) - windowMs;
    const currentCount = numberOr(current?.count, errors.filter((item) => matches(item, rule) && toMillis(item.occurred_at) >= cutoff).length);
    const baselineCount = numberOr(baseline?.count, 0);
    const minSamples = positiveInteger(rule.min_samples, 5);
    const multiplier = positiveNumber(rule.multiplier, 2);
    return {
      active: currentCount >= minSamples && baselineCount > 0 && currentCount >= baselineCount * multiplier,
      suppressed: false,
      reason: `${currentCount} errors vs baseline ${baselineCount}`,
      dedupKey,
      evidence: { current: currentCount, baseline: baselineCount, min_samples: minSamples, multiplier }
    };
  }

  const currentCount = numberOr(current?.count, 0);
  const baselineCount = numberOr(baseline?.count, 0);
  const minSamples = positiveInteger(rule.min_samples, 5);
  const dropPercent = positiveNumber(rule.drop_percent, 30);
  const dropRatio = baselineCount > 0 ? ((baselineCount - currentCount) / baselineCount) * 100 : 0;
  return {
    active: baselineCount >= minSamples && dropRatio >= dropPercent,
    suppressed: false,
    reason: `journey count ${currentCount} vs baseline ${baselineCount} (${dropRatio.toFixed(1)}% drop)`,
    dedupKey,
    evidence: { current: currentCount, baseline: baselineCount, min_samples: minSamples, drop_percent: dropPercent }
  };
}

export function isMonitorDue(monitor, lastRunAt, now = new Date()) {
  if (!lastRunAt) return true;
  const intervalMs = positiveNumber(monitor?.interval_seconds, 60) * 1000;
  return toMillis(now) - toMillis(lastRunAt) >= intervalMs;
}

export function transitionAlert({
  evaluation,
  existing,
  now = new Date(),
  cooldownSeconds = 300,
  recoveryThreshold = 1
}) {
  const timestamp = new Date(toMillis(now)).toISOString();
  if (evaluation.suppressed) {
    return { status: existing?.status ?? null, notify: false, alert: existing ?? null, notificationType: null };
  }

  if (evaluation.active) {
    const shouldOpen = !existing || existing.status === "resolved";
    const lastNotifiedMs = toMillis(existing?.last_notified_at);
    const cooldownElapsed = !Number.isFinite(lastNotifiedMs)
      || toMillis(now) - lastNotifiedMs >= positiveNumber(cooldownSeconds, 300) * 1000;
    const notify = shouldOpen || cooldownElapsed;
    const alert = {
      ...(existing ?? {}),
      dedup_key: evaluation.dedupKey,
      status: shouldOpen ? "open" : existing.status,
      reason: evaluation.reason,
      evidence: evaluation.evidence ?? {},
      opened_at: shouldOpen ? timestamp : existing.opened_at,
      resolved_at: null,
      last_seen_at: timestamp,
      last_notified_at: notify ? timestamp : existing.last_notified_at,
      recovery_count: 0,
      recovery_notified_at: null,
      occurrence_count: Number(existing?.occurrence_count ?? 0) + 1
    };
    return { status: alert.status, notify, alert, notificationType: notify ? "alert" : null };
  }

  if (!existing) return { status: null, notify: false, alert: null, notificationType: null };
  if (existing.status === "resolved") return { status: "resolved", notify: false, alert: { ...existing }, notificationType: null };

  const recoveryCount = Number(existing.recovery_count ?? 0) + 1;
  if (recoveryCount < positiveInteger(recoveryThreshold, 1)) {
    const alert = { ...existing, recovery_count: recoveryCount, last_seen_at: timestamp };
    return { status: alert.status, notify: false, alert, notificationType: null };
  }

  const notify = !existing.recovery_notified_at;
  const alert = {
    ...existing,
    status: "resolved",
    reason: evaluation.reason,
    resolved_at: timestamp,
    last_seen_at: timestamp,
    recovery_count: recoveryCount,
    recovery_notified_at: notify ? timestamp : existing.recovery_notified_at
  };
  return { status: alert.status, notify, alert, notificationType: notify ? "recovery" : null };
}

export function acknowledgeAlert(alert, { actor, now = new Date() } = {}) {
  if (!alert || !["open", "acknowledged"].includes(alert.status)) {
    throw new Error("Only open alerts can be acknowledged");
  }
  return {
    ...alert,
    status: "acknowledged",
    acknowledged_by: actor ?? "unknown",
    acknowledged_at: new Date(toMillis(now)).toISOString()
  };
}

export function alertDedupKey(rule) {
  const target = rule.monitor_id ?? rule.event ?? rule.journey_id ?? rule.signal ?? "telemetry";
  return [rule.product_id, rule.environment, rule.type, target].map((value) => String(value ?? "unknown")).join(":");
}

function isInMaintenance(rule, windows, now) {
  const nowMs = toMillis(now);
  return windows.some((window) => (
    (!window.product_id || window.product_id === rule.product_id)
    && (!window.environment || window.environment === rule.environment)
    && toMillis(window.starts_at) <= nowMs
    && nowMs < toMillis(window.ends_at)
  ));
}

function matches(item, rule) {
  return (!rule.product_id || item.product_id === rule.product_id)
    && (!rule.environment || item.environment === rule.environment);
}

function newestFirst(items, field) {
  return [...items].sort((left, right) => toMillis(right[field]) - toMillis(left[field]));
}

function countConsecutive(items, predicate) {
  let count = 0;
  for (const item of items) {
    if (!predicate(item)) break;
    count += 1;
  }
  return count;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}
