import { promises as fs } from "node:fs";
import path from "node:path";
import {
  loadProductContract,
  parseProductContractText
} from "@ai-product-reliability/standard/product-contract";

export async function generateAutomation(projectPath, options = {}) {
  const root = path.resolve(projectPath);
  const contractResult = await loadProductContract(root);
  if (!contractResult) {
    throw new Error(`No product.yml found in ${root}`);
  }
  const contract = contractResult.contract;
  const outDir = path.resolve(options.outDir ?? path.join(root, "reliability", "generated"));
  const dashboardUrl = options.dashboardUrl ?? "http://127.0.0.1:8787";
  const now = new Date().toISOString();

  const monitors = buildMonitors(contract, dashboardUrl);
  const alerts = buildAlerts(contract, monitors);
  const statusPage = buildStatusPage(contract, monitors, now);
  const incidentPackage = buildIncidentPackage(contract, monitors, alerts, now);

  await fs.mkdir(outDir, { recursive: true });
  const files = {
    "monitors.json": JSON.stringify({ generated_at: now, product_id: contract.product.id, monitors }, null, 2),
    "alerts.json": JSON.stringify({ generated_at: now, product_id: contract.product.id, alerts }, null, 2),
    "status-page.md": statusPage,
    "ai-incident-package.md": incidentPackage
  };

  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(outDir, name), contents, "utf8");
  }

  const dashboardApiKey = options.dashboardApiKey ?? options.apiKey;
  const dashboardRegistrations = options.registerDashboard
    ? await registerDashboardArtifacts(dashboardUrl, contract, monitors, alerts, statusPage, dashboardApiKey)
    : null;

  return {
    product_id: contract.product.id,
    outDir,
    files: Object.keys(files).map((name) => path.join(outDir, name)),
    monitors,
    alerts,
    warnings: contractResult.warnings,
    migration_advice: contractResult.migration_advice,
    dashboardRegistrations
  };
}

export function buildMonitors(contract, dashboardUrl) {
  const production = contract.environments.find((env) => env.name === "production") ?? contract.environments[0] ?? {};
  const environment = production.name ?? "production";
  const baseUrl = (production.url || "").replace(/\/$/, "");
  const livePath = contract.health.live_path ?? "/healthz";
  const readyPath = contract.health.ready_path ?? "/readyz";
  const monitors = [];

  if (baseUrl) {
    monitors.push({
      id: `${contract.product.id}-healthz`,
      product_id: contract.product.id,
      environment,
      type: "http",
      name: `${contract.product.name} liveness`,
      url: `${baseUrl}${livePath}`,
      interval_seconds: 60,
      expected_status: 200,
      severity: "critical"
    });
    monitors.push({
      id: `${contract.product.id}-readyz`,
      product_id: contract.product.id,
      environment,
      type: "http",
      name: `${contract.product.name} readiness`,
      url: `${baseUrl}${readyPath}`,
      interval_seconds: 120,
      expected_status: 200,
      severity: "high"
    });
  }

  for (const journey of contract.critical_journeys) {
    monitors.push({
      id: `${contract.product.id}-${journey.id}-journey`,
      product_id: contract.product.id,
      environment,
      type: "event-freshness",
      name: `${journey.name} success event freshness`,
      event: journey.success_event,
      window_minutes: 60,
      min_count: 1,
      severity: "medium"
    });
  }

  monitors.push({
    id: `${contract.product.id}-dashboard-ingest`,
    product_id: contract.product.id,
    environment,
    type: "collector",
    name: "Dashboard ingestion endpoint",
    url: `${dashboardUrl.replace(/\/$/, "")}/api/ingest`,
    interval_seconds: 300,
    severity: "medium"
  });

  return monitors;
}

export function buildAlerts(contract, monitors = buildMonitors(contract, "http://127.0.0.1:8787")) {
  const production = contract.environments.find((env) => env.name === "production") ?? contract.environments[0] ?? {};
  const environment = production.name ?? "production";
  const notify = [contract.product.owner];
  const availabilityRules = monitors
    .filter((monitor) => monitor.type === "http")
    .map((monitor) => ({
      id: `${monitor.id}-availability`,
      product_id: contract.product.id,
      environment: monitor.environment ?? environment,
      type: "availability_failure",
      monitor_id: monitor.id,
      name: `${monitor.name} failing`,
      severity: monitor.severity ?? "high",
      consecutive_failures: monitor.severity === "critical" ? 2 : 3,
      cooldown_seconds: 300,
      recovery_threshold: 2,
      notify,
      action: "Check the endpoint, latest release, dependencies, and hosting status."
    }));
  const collector = monitors.find((monitor) => monitor.type === "collector");

  return [
    ...availabilityRules,
    {
      id: `${contract.product.id}-telemetry-stale`,
      product_id: contract.product.id,
      environment,
      type: "telemetry_stale",
      monitor_id: collector?.id ?? `${contract.product.id}-dashboard-ingest`,
      event: "telemetry_received",
      name: "Product telemetry is stale",
      severity: "high",
      min_samples: 1,
      window_seconds: 900,
      cooldown_seconds: 600,
      recovery_threshold: 1,
      notify,
      action: "Check SDK delivery, collector availability, credentials, and the latest release."
    },
    {
      id: `${contract.product.id}-error-spike`,
      product_id: contract.product.id,
      environment,
      type: "error_spike",
      name: "Release error spike",
      severity: "high",
      min_samples: 5,
      window_seconds: 900,
      multiplier: 2,
      cooldown_seconds: 600,
      recovery_threshold: 2,
      notify,
      action: "Open the incident package and compare errors by release."
    },
    ...contract.critical_journeys.map((journey) => ({
      id: `${contract.product.id}-${journey.id}-journey-drop`,
      product_id: contract.product.id,
      environment,
      type: "journey_drop",
      journey_id: journey.id,
      event: journey.success_event,
      name: `${journey.name} success rate dropped`,
      severity: "high",
      min_samples: 5,
      window_seconds: 3600,
      drop_percent: 30,
      cooldown_seconds: 900,
      recovery_threshold: 2,
      notify,
      action: "Check journey events, user-facing errors, dependencies, and recent releases."
    }))
  ];
}

function buildStatusPage(contract, monitors, now) {
  return `# ${contract.product.name} Status Page

Generated: ${now}

## Current Status

- Overall: Unknown until connected to live monitors.
- Product ID: ${contract.product.id}
- Owner: ${contract.product.owner}

## Components

${monitors.map((monitor) => `- ${monitor.name}: pending`).join("\n")}

## User Communication Template

We are investigating an issue affecting ${contract.product.name}. We will update this page when we have confirmed scope, mitigation, and recovery.
`;
}

function buildIncidentPackage(contract, monitors, alerts, now) {
  return `# AI Incident Package

Generated: ${now}

## Product

- Product ID: ${contract.product.id}
- Name: ${contract.product.name}
- Owner: ${contract.product.owner}
- Standard version: ${contract.standard_version}

## First Questions For AI Debugging

1. Which critical journey is affected?
2. Which release introduced the change?
3. Did errors, health checks, or event conversion change first?
4. Is the issue isolated to one environment, dependency, or client version?

## Evidence To Collect

- Current release and previous known good release.
- Error IDs and stack traces from the current release.
- Logs with request ID, user/session ID, product ID, environment, and timestamp.
- Health and readiness responses.
- Core journey success/failure event counts.
- Recent config and deployment changes.

## Monitors

${monitors.map((monitor) => `- ${monitor.id}: ${monitor.name} (${monitor.type})`).join("\n")}

## Alerts

${alerts.map((alert) => `- ${alert.id}: ${alert.type}`).join("\n")}

## Suggested AI Prompt

Use the files in this package plus the latest logs, events, errors, and release diff. Identify the most likely root cause, the smallest safe mitigation, verification steps, and rollback risk.
`;
}

async function registerDashboardArtifacts(dashboardUrl, contract, monitors, alerts, statusPage, apiKey) {
  const endpoint = dashboardUrl.replace(/\/$/, "");
  const productResult = await postJson(`${endpoint}/api/products`, {
    standard_version: contract.standard_version,
    product: contract.product,
    environments: contract.environments,
    critical_journeys: contract.critical_journeys,
    contract
  }, apiKey);
  const monitorResult = await postJson(`${endpoint}/api/monitors`, { items: monitors }, apiKey);
  const alertResult = await postJson(`${endpoint}/api/alerts`, { items: alerts }, apiKey);
  const statusResult = await postJson(`${endpoint}/api/status-pages`, {
    product_id: contract.product.id,
    title: `${contract.product.name} Status Page`,
    body: statusPage,
    generated_at: new Date().toISOString()
  }, apiKey);
  return {
    product: productResult,
    monitors: monitorResult,
    alerts: alertResult,
    status_page: statusResult
  };
}

async function postJson(url, payload, apiKey) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`POST ${url} failed: ${response.status}${text ? ` ${text}` : ""}`);
  }
  return response.json().catch(() => ({ ok: true }));
}

export function parseProductContract(text, source = "product.yml") {
  return parseProductContractText(text, source).contract;
}
