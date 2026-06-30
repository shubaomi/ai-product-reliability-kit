import { promises as fs } from "node:fs";
import path from "node:path";

export async function generateAutomation(projectPath, options = {}) {
  const root = path.resolve(projectPath);
  const contractPath = await findContract(root);
  if (!contractPath) {
    throw new Error(`No product.yml found in ${root}`);
  }

  const contractText = await fs.readFile(contractPath, "utf8");
  const contract = parseProductContract(contractText);
  const outDir = path.resolve(options.outDir ?? path.join(root, "reliability", "generated"));
  const dashboardUrl = options.dashboardUrl ?? "http://127.0.0.1:8787";
  const now = new Date().toISOString();

  const monitors = buildMonitors(contract, dashboardUrl);
  const alerts = buildAlerts(contract);
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
    dashboardRegistrations
  };
}

export function buildMonitors(contract, dashboardUrl) {
  const production = contract.environments.find((env) => env.name === "production") ?? contract.environments[0] ?? {};
  const baseUrl = (production.url || "").replace(/\/$/, "");
  const livePath = contract.health.live_path ?? "/healthz";
  const readyPath = contract.health.ready_path ?? "/readyz";
  const monitors = [];

  if (baseUrl) {
    monitors.push({
      id: `${contract.product.id}-healthz`,
      product_id: contract.product.id,
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
    type: "collector",
    name: "Dashboard ingestion endpoint",
    url: `${dashboardUrl.replace(/\/$/, "")}/api/ingest`,
    interval_seconds: 300,
    severity: "medium"
  });

  return monitors;
}

export function buildAlerts(contract) {
  return [
    {
      id: `${contract.product.id}-health-down`,
      product_id: contract.product.id,
      name: "Health check failing",
      condition: "http_monitor_failed >= 2 consecutive checks",
      severity: "critical",
      notify: [contract.product.owner],
      action: "Check /healthz, latest release, and hosting provider status."
    },
    {
      id: `${contract.product.id}-error-spike`,
      product_id: contract.product.id,
      name: "Release error spike",
      condition: "errors_current_release > errors_previous_release * 2 and errors_current_release >= 5",
      severity: "high",
      notify: [contract.product.owner],
      action: "Open AI incident package and compare recent errors by release."
    },
    {
      id: `${contract.product.id}-journey-drop`,
      product_id: contract.product.id,
      name: "Critical journey event drop",
      condition: "success_event_count drops by 30 percent in 60 minutes",
      severity: "high",
      notify: [contract.product.owner],
      action: "Check product analytics, recent deploys, and user-facing errors."
    }
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

${alerts.map((alert) => `- ${alert.id}: ${alert.condition}`).join("\n")}

## Suggested AI Prompt

Use the files in this package plus the latest logs, events, errors, and release diff. Identify the most likely root cause, the smallest safe mitigation, verification steps, and rollback risk.
`;
}

async function registerDashboardArtifacts(dashboardUrl, contract, monitors, alerts, statusPage, apiKey) {
  const endpoint = dashboardUrl.replace(/\/$/, "");
  const monitorResult = await postJson(`${endpoint}/api/monitors`, { items: monitors }, apiKey);
  const alertResult = await postJson(`${endpoint}/api/alerts`, { items: alerts }, apiKey);
  const statusResult = await postJson(`${endpoint}/api/status-pages`, {
    product_id: contract.product.id,
    title: `${contract.product.name} Status Page`,
    body: statusPage,
    generated_at: new Date().toISOString()
  }, apiKey);
  return {
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

async function findContract(root) {
  for (const candidate of ["product.yml", "product.yaml", "reliability/product.yml", "config/product.yml"]) {
    const fullPath = path.join(root, candidate);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function parseProductContract(text) {
  const productBlock = block(text, "product");
  const healthBlock = block(text, "health");
  return {
    standard_version: scalar(text, "standard_version") ?? "unknown",
    product: {
      id: scalar(productBlock, "id") ?? "unknown-product",
      name: scalar(productBlock, "name") ?? "Unknown Product",
      owner: scalar(productBlock, "owner") ?? "unknown"
    },
    environments: parseEnvironments(block(text, "environments")),
    critical_journeys: parseJourneys(block(text, "critical_journeys")),
    health: {
      live_path: scalar(healthBlock, "live_path") ?? "/healthz",
      ready_path: scalar(healthBlock, "ready_path") ?? "/readyz"
    }
  };
}

function parseEnvironments(text) {
  const items = splitListObjects(text);
  return items.map((item) => ({
    name: scalar(item, "name") ?? "production",
    url: scalar(item, "url") ?? ""
  }));
}

function parseJourneys(text) {
  const items = splitListObjects(text);
  return items.map((item) => ({
    id: scalar(item, "id") ?? "journey",
    name: scalar(item, "name") ?? scalar(item, "id") ?? "Journey",
    success_event: scalar(item, "success_event") ?? "journey_completed",
    failure_event: scalar(item, "failure_event")
  }));
}

function block(text, key) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.match(new RegExp(`^${key}:\\s*$`)));
  if (start < 0) return "";
  const collected = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^[A-Za-z0-9_]+:\s*/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n");
}

function splitListObjects(text) {
  const items = [];
  let current = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*-\s+/.test(line)) {
      if (current.length) items.push(current.join("\n"));
      current = [line.replace(/^\s*-\s+/, "")];
    } else if (current.length) {
      current.push(line);
    }
  }
  if (current.length) items.push(current.join("\n"));
  return items;
}

function scalar(text, key) {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*["']?([^"'\\n]+)["']?`, "i"));
  return match?.[1]?.trim() ?? null;
}
