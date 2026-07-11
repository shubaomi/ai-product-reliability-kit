export const OPERATIONAL_STATES = Object.freeze(["unknown", "operational", "degraded", "outage"]);

const STATE_RANK = Object.freeze({
  operational: 1,
  unknown: 2,
  degraded: 3,
  outage: 4
});

export function deriveEnvironmentStatus({
  productId,
  environment,
  healthChecks = [],
  configuredMonitors = [],
  monitorRuns = [],
  activeAlerts = [],
  incidents = [],
  now = new Date(),
  staleAfterMs = 5 * 60_000,
  criticalFailureThreshold = 2
}) {
  const nowMs = toMillis(now);
  const health = newestFirst(healthChecks.filter((item) => matches(item, productId, environment)), "occurred_at");
  const runs = newestFirst(monitorRuns.filter((item) => matches(item, productId, environment)), "checked_at");
  const monitorDefinitions = configuredMonitors.filter((item) => matches(item, productId, environment));
  const monitors = monitorDefinitions.filter((item) => item.enabled !== false);
  const alerts = activeAlerts.filter((item) => (
    matches(item, productId, environment)
    && ["open", "acknowledged"].includes(String(item.status).toLowerCase())
  ));
  const activeIncidents = incidents.filter((item) => (
    matches(item, productId, environment)
    && ["open", "acknowledged"].includes(String(item.status).toLowerCase())
  ));

  const reasons = [];
  const criticalIncident = activeIncidents.find((item) => String(item.severity).toLowerCase() === "critical");
  if (criticalIncident) {
    reasons.push(reason("critical_incident", "Critical incident is unresolved", criticalIncident));
    return result("outage", reasons, latestTimestamp(health, runs, alerts, activeIncidents));
  }
  const criticalAlert = alerts.find((item) => String(item.severity).toLowerCase() === "critical");
  if (criticalAlert) {
    reasons.push(reason("active_alert", `Critical ${criticalAlert.rule_type ?? "reliability"} alert is active`, criticalAlert));
    return result("outage", reasons, latestTimestamp(health, runs, alerts, activeIncidents));
  }
  if (activeIncidents.length) {
    reasons.push(reason("incident", "Incident is unresolved", activeIncidents[0]));
  }
  for (const alert of alerts) {
    reasons.push(reason("active_alert", `${alert.rule_type ?? "Reliability"} alert is active`, alert));
  }

  const freshHealth = health.filter((item) => isFresh(item.occurred_at, nowMs, staleAfterMs));
  const latestHealth = freshHealth[0];
  const consecutiveHealthFailures = countConsecutive(freshHealth, (item) => item.payload?.ok === false);
  if (consecutiveHealthFailures >= criticalFailureThreshold) {
    reasons.push(reason("health_failure", `${consecutiveHealthFailures} consecutive health failures`, latestHealth));
    return result("outage", reasons, latestTimestamp(health, runs, alerts, activeIncidents));
  }
  if (latestHealth?.payload?.ok === false) {
    reasons.push(reason("health_failure", "Latest health report is failing", latestHealth));
  }

  const latestRuns = latestBy(runs, (item) => item.monitor_id ?? item.id);
  const monitorDefinitionsById = new Map(monitorDefinitions.map((monitor) => [monitor.id, monitor]));
  const unknownReasons = [];
  for (const monitor of monitors) {
    const run = latestRuns.get(monitor.id);
    if (!run && String(monitor.severity ?? "medium").toLowerCase() === "critical") {
      unknownReasons.push(reason("monitor_unknown", `${monitor.id} has not completed a check`, monitor));
    }
  }
  let criticalOutage = false;
  for (const run of latestRuns.values()) {
    const monitorId = run.monitor_id ?? run.id ?? "monitor";
    const definition = monitorDefinitionsById.get(monitorId);
    if (definition?.enabled === false) continue;
    const effective = { ...run, ...definition, monitor_id: monitorId, checked_at: run.checked_at, ok: run.ok };
    const fresh = isFresh(run.checked_at, nowMs, monitorFreshness(effective, staleAfterMs));
    const severity = String(effective.severity ?? "medium").toLowerCase();
    if (!fresh) {
      if (severity === "critical") unknownReasons.push(reason("monitor_stale", `${monitorId} has a stale result`, run));
      continue;
    }
    if (run.ok !== false) continue;
    const history = runs.filter((item) => (item.monitor_id ?? item.id) === monitorId);
    const failures = countConsecutive(history, (item) => item.ok === false);
    const threshold = positiveInteger(effective.failure_threshold, criticalFailureThreshold);
    if (severity === "critical" && failures >= threshold) {
      criticalOutage = true;
      reasons.push(reason("critical_monitor_failure", `${monitorId} failed ${failures} consecutive checks`, run));
    } else {
      reasons.push(reason("monitor_failure", `${monitorId} is failing`, run));
    }
  }
  if (criticalOutage) return result("outage", reasons, latestTimestamp(health, runs, alerts, activeIncidents));
  if (reasons.length) return result("degraded", reasons, latestTimestamp(health, runs, alerts, activeIncidents));

  if (!latestHealth || latestHealth.payload?.ok !== true) {
    const message = health.length ? "Latest health report is stale" : "No health data has been received";
    return result("unknown", [...unknownReasons, reason("telemetry_unknown", message, health[0])], latestTimestamp(health, runs, alerts, activeIncidents));
  }

  if (unknownReasons.length) {
    return result("unknown", unknownReasons, latestTimestamp(health, runs, alerts, activeIncidents));
  }

  return result("operational", [], latestTimestamp(health, runs, alerts, activeIncidents));
}

export function aggregateFleetStatus(statuses = []) {
  if (!statuses.length) return "unknown";
  return statuses.reduce((current, item) => {
    const candidate = OPERATIONAL_STATES.includes(item?.status) ? item.status : "unknown";
    return STATE_RANK[candidate] > STATE_RANK[current] ? candidate : current;
  }, "operational");
}

function matches(item, productId, environment) {
  return (!productId || item.product_id === productId)
    && (!environment || item.environment === environment);
}

function newestFirst(items, field) {
  return [...items].sort((left, right) => toMillis(right[field]) - toMillis(left[field]));
}

function latestBy(items, keyFn) {
  const latest = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (key != null && !latest.has(key)) latest.set(key, item);
  }
  return latest;
}

function countConsecutive(items, predicate) {
  let count = 0;
  for (const item of items) {
    if (!predicate(item)) break;
    count += 1;
  }
  return count;
}

function isFresh(value, nowMs, maxAgeMs) {
  const timestamp = toMillis(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp <= maxAgeMs;
}

function monitorFreshness(run, fallback) {
  const intervalMs = Number(run.interval_seconds) * 1000;
  return Number.isFinite(intervalMs) && intervalMs > 0 ? Math.max(fallback, intervalMs * 2) : fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function latestTimestamp(...collections) {
  const values = collections.flat().flatMap((item) => [item.occurred_at, item.checked_at, item.updated_at, item.created_at]);
  const latest = values.map(toMillis).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return latest == null ? null : new Date(latest).toISOString();
}

function result(status, reasons, updatedAt) {
  return { status, reasons, updated_at: updatedAt };
}

function reason(code, message, source) {
  return {
    code,
    message,
    source_id: source?.id ?? source?.monitor_id ?? null
  };
}

function toMillis(value) {
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}
