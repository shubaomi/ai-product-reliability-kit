import { deliverAlert } from "./alerts.mjs";

export async function runSchedulerOnce(store, config, options = {}) {
  const monitors = await store.listMonitors({ enabledOnly: true });
  const alerts = await store.listAlerts({ enabledOnly: true });
  const results = [];

  for (const monitor of monitors) {
    const result = await runMonitor(store, monitor, options);
    results.push(result);
    if (!result.ok) {
      const alert = matchingAlert(alerts, monitor, result);
      if (alert) await deliverAlert(store, alert, result, config);
    }
  }

  return { checked: results.length, failed: results.filter((item) => !item.ok).length, results };
}

export function startScheduler(store, config) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerOnce(store, config);
    } catch (error) {
      console.error("Scheduler failed", error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, config.workerIntervalMs);
  tick();
  return () => clearInterval(timer);
}

async function runMonitor(store, monitor, options) {
  if (monitor.type === "event-freshness") return runEventFreshnessMonitor(store, monitor);
  if (monitor.type === "collector") return runCollectorMonitor(store, monitor, options);
  return runHttpMonitor(store, monitor, options);
}

async function runHttpMonitor(store, monitor, options) {
  return runUrlMonitor(store, monitor, monitor.url, options);
}

async function runCollectorMonitor(store, monitor, options) {
  return runUrlMonitor(store, monitor, collectorCheckUrl(monitor.url), options);
}

async function runUrlMonitor(store, monitor, url, options) {
  const started = Date.now();
  const timeoutMs = monitor.timeout_ms ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let ok = false;
  let status = "error";
  let details = {};
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "GET",
      signal: controller.signal
    });
    status = String(response.status);
    ok = response.status === (monitor.expected_status ?? 200);
    details = { url, status: response.status };
  } catch (error) {
    status = error.name === "AbortError" ? "timeout" : "error";
    details = { url, error: error.message };
  } finally {
    clearTimeout(timer);
  }
  const run = {
    monitor_id: monitor.id,
    product_id: monitor.product_id ?? productIdFromMonitor(monitor),
    ok,
    status,
    latency_ms: Date.now() - started,
    details
  };
  await store.recordMonitorRun(run);
  return run;
}

function collectorCheckUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname === "/api/ingest") url.pathname = "/api/status";
  return url.toString();
}

async function runEventFreshnessMonitor(store, monitor) {
  const productId = monitor.product_id ?? productIdFromMonitor(monitor);
  const since = new Date(Date.now() - (monitor.window_minutes ?? 60) * 60 * 1000);
  const count = await store.countEvents(productId, monitor.event, since);
  const ok = count >= (monitor.min_count ?? 1);
  const run = {
    monitor_id: monitor.id,
    product_id: productId,
    ok,
    status: ok ? "fresh" : "stale",
    latency_ms: 0,
    details: { event: monitor.event, count, since: since.toISOString() }
  };
  await store.recordMonitorRun(run);
  return run;
}

function matchingAlert(alerts, monitor, result) {
  const productId = result.product_id;
  return alerts.find((alert) =>
    (alert.product_id === productId || monitor.id.startsWith(alert.product_id ?? "")) &&
    (alert.condition?.includes("health") || alert.condition?.includes("success_event") || alert.condition?.includes("http_monitor_failed"))
  );
}

function productIdFromMonitor(monitor) {
  if (monitor.product_id) return monitor.product_id;
  return String(monitor.id).replace(/-(healthz|readyz|dashboard-ingest|.+-journey)$/, "");
}
