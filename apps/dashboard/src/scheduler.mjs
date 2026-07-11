import { alertDedupKey, evaluateAlertRule, isMonitorDue, transitionAlert } from "./alert-rules.mjs";
import { deliverAlert } from "./alerts.mjs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { resolveSafeMonitorTarget } from "./validation.mjs";

export async function runSchedulerOnce(store, config = {}, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const monitors = await store.listMonitors({ enabledOnly: true });
  const alerts = await store.listAlerts({ enabledOnly: true });
  const results = [];
  let skipped = 0;
  let maintenanceSkipped = 0;

  for (const monitor of monitors) {
    const lastRun = await store.lastMonitorRun?.(monitor.id);
    if (!isMonitorDue(monitor, lastRun?.checked_at, now)) {
      skipped += 1;
      continue;
    }
    const maintenance = await activeMaintenance(store, monitor, now);
    if (maintenance.length) {
      maintenanceSkipped += 1;
      continue;
    }
    results.push(await runMonitor(store, monitor, config, { ...options, now }));
  }

  for (const rule of alerts) {
    await evaluateAndPersistAlert(store, rule, config, { ...options, now });
  }

  return {
    checked: results.length,
    failed: results.filter((item) => !item.ok).length,
    skipped,
    maintenance_skipped: maintenanceSkipped,
    results
  };
}

export function startScheduler(store, config, options = {}) {
  let stopped = false;
  let active = null;
  const intervalMs = options.intervalMs ?? config.workerIntervalMs ?? 60_000;
  const run = async () => {
    if (stopped || active) return active;
    const task = async () => runSchedulerOnce(store, config, options);
    active = (store.withSchedulerLease ? store.withSchedulerLease(task) : task())
      .catch((error) => console.error("Scheduler failed", error))
      .finally(() => { active = null; });
    return active;
  };
  const timer = setInterval(run, intervalMs);
  if (options.runImmediately !== false) void run();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}

async function runMonitor(store, monitor, config, options) {
  if (monitor.type === "event-freshness") return runEventFreshnessMonitor(store, monitor, options.now);
  if (monitor.type === "collector") return runUrlMonitor(store, monitor, collectorCheckUrl(monitor.url), config, options);
  return runUrlMonitor(store, monitor, monitor.url, config, options);
}

async function runUrlMonitor(store, monitor, rawUrl, config, options) {
  const checkedAt = options.now.toISOString();
  let target;
  try {
    target = await resolveSafeMonitorTarget(rawUrl, config, { dnsLookup: options.dnsLookup ?? config.dnsLookup });
  } catch (error) {
    const run = monitorRun(monitor, {
      ok: false,
      status: "unsafe_url",
      checked_at: checkedAt,
      latency_ms: 0,
      details: { url: rawUrl, error: error.message }
    });
    await store.recordMonitorRun(run);
    return run;
  }

  const started = Date.now();
  const timeoutMs = monitor.timeout_ms ?? Number(monitor.timeout_seconds ?? 10) * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ok = false;
  let status = "error";
  let details = {};
  try {
    const response = await requestPinnedMonitorUrl(target, controller.signal, options);
    status = String(response.status);
    ok = response.status === (monitor.expected_status ?? 200);
    details = { url: target.url.toString(), status: response.status };
  } catch (error) {
    status = error.name === "AbortError" ? "timeout" : "error";
    details = { url: target.url.toString(), error: error.message };
  } finally {
    clearTimeout(timer);
  }
  const run = monitorRun(monitor, {
    ok,
    status,
    checked_at: checkedAt,
    latency_ms: Date.now() - started,
    details
  });
  await store.recordMonitorRun(run);
  return run;
}

async function requestPinnedMonitorUrl(target, signal, options) {
  const requestOptions = {
    method: "GET",
    signal,
    redirect: "manual",
    lookup: target.lookup,
    resolved_address: target.address,
    resolved_family: target.family
  };
  if (options.fetchImpl) return options.fetchImpl(target.url.toString(), requestOptions);
  if (options.requestImpl) return options.requestImpl({ ...target, signal, method: "GET" });

  return new Promise((resolve, reject) => {
    const transport = target.url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let request;
    const abort = () => request?.destroy(signal.reason instanceof Error ? signal.reason : new Error("Monitor request aborted"));
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    try {
      request = transport({
        protocol: target.url.protocol,
        hostname: target.hostname,
        port: target.url.port || undefined,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        headers: { host: target.url.host },
        lookup: target.lookup,
        ...(target.url.protocol === "https:" && !net.isIP(target.hostname) ? { servername: target.hostname } : {})
      }, (response) => {
        response.resume();
        finish(resolve, { status: response.statusCode });
      });
      request.once("error", (error) => finish(reject, error));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
      request.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

async function runEventFreshnessMonitor(store, monitor, now) {
  const productId = monitor.product_id ?? productIdFromMonitor(monitor);
  const since = new Date(now.getTime() - (monitor.window_minutes ?? 60) * 60_000);
  const count = await store.countEvents(productId, monitor.event, since, monitor.environment ?? "production");
  const ok = count >= (monitor.min_count ?? 1);
  const run = monitorRun(monitor, {
    ok,
    status: ok ? "fresh" : "stale",
    checked_at: now.toISOString(),
    latency_ms: 0,
    details: { event: monitor.event, count, since: since.toISOString() }
  });
  await store.recordMonitorRun(run);
  return run;
}

async function evaluateAndPersistAlert(store, rule, config, options) {
  const productId = rule.product_id;
  const environment = rule.environment ?? "production";
  const monitorRuns = await store.listMonitorRuns({ productId, environment, limit: 2_000 });
  const maintenanceWindows = await store.listMaintenanceWindows?.({ productId, environment, activeAt: options.now.toISOString() }) ?? [];
  const data = await ruleData(store, rule, options.now);
  const evaluation = evaluateAlertRule({ rule: { ...rule, environment }, monitorRuns, maintenanceWindows, now: options.now, ...data });
  const dedupKey = evaluation.dedupKey ?? alertDedupKey(rule);
  const existing = (await store.listAlertInstances?.({ productId, environment }) ?? []).find((item) => item.dedup_key === dedupKey);
  const transition = transitionAlert({
    evaluation,
    existing,
    now: options.now,
    cooldownSeconds: rule.cooldown_seconds ?? 300,
    recoveryThreshold: rule.recovery_threshold ?? 1
  });
  if (!transition.alert) return transition;

  const instance = await store.upsertAlertInstance({
    ...transition.alert,
    rule_id: rule.id,
    rule_type: rule.type,
    product_id: productId,
    environment,
    severity: rule.severity ?? "medium",
    name: rule.name
  });
  if (transition.notify) {
    await deliverAlert(store, rule, { evaluation, instance }, config, {
      notificationType: transition.notificationType,
      now: options.now,
      fetchImpl: options.alertFetchImpl
    });
  }
  return transition;
}

async function ruleData(store, rule, now) {
  const productId = rule.product_id;
  const environment = rule.environment ?? "production";
  if (rule.type === "telemetry_stale") {
    const [health, events, errors, releases] = await Promise.all([
      store.listHealth({ productId, environment, limit: 1 }),
      store.listEvents(1, { productId, environment }),
      store.listErrors(1, { productId, environment }),
      store.listReleases(1, { productId, environment })
    ]);
    return { telemetry: [...health, ...events, ...errors, ...releases] };
  }

  const windowMs = Number(rule.window_seconds ?? 900) * 1000;
  const nowMs = now.getTime();
  if (rule.type === "error_spike") {
    const errors = await store.listErrors(5_000, { productId, environment });
    return countsForWindows(errors, "occurred_at", nowMs, windowMs, () => true, "errors");
  }
  if (rule.type === "journey_drop") {
    const events = await store.listEvents(5_000, { productId, environment });
    return countsForWindows(events, "occurred_at", nowMs, windowMs, (item) => item.payload?.event === rule.event, "events");
  }
  return {};
}

function countsForWindows(items, timestampField, nowMs, windowMs, predicate, field) {
  const currentCount = items.filter((item) => predicate(item) && Date.parse(item[timestampField]) >= nowMs - windowMs && Date.parse(item[timestampField]) <= nowMs).length;
  const baselineCount = items.filter((item) => predicate(item) && Date.parse(item[timestampField]) >= nowMs - 2 * windowMs && Date.parse(item[timestampField]) < nowMs - windowMs).length;
  return { [field]: items, current: { count: currentCount }, baseline: { count: baselineCount } };
}

async function activeMaintenance(store, monitor, now) {
  if (!store.listMaintenanceWindows) return [];
  return store.listMaintenanceWindows({
    productId: monitor.product_id ?? productIdFromMonitor(monitor),
    environment: monitor.environment ?? "production",
    activeAt: now.toISOString()
  });
}

function monitorRun(monitor, values) {
  return {
    monitor_id: monitor.id,
    product_id: monitor.product_id ?? productIdFromMonitor(monitor),
    environment: monitor.environment ?? "production",
    severity: monitor.severity ?? "medium",
    failure_threshold: monitor.failure_threshold ?? monitor.consecutive_failures ?? 2,
    interval_seconds: monitor.interval_seconds ?? 60,
    ...values
  };
}

function collectorCheckUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname === "/api/ingest") url.pathname = "/api/status";
  return url.toString();
}

function productIdFromMonitor(monitor) {
  if (monitor.product_id) return monitor.product_id;
  return String(monitor.id).replace(/-(healthz|readyz|dashboard-ingest|.+-journey)$/, "");
}
