#!/usr/bin/env node
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "./src/config.mjs";
import { createApiKeySecret, createSecurity, hashSecret } from "./src/security.mjs";
import {
  hashIdentifier,
  httpError,
  normalizeProduct,
  validateApiKeyRequest,
  validateComplianceScan,
  validateIngestBatch,
  validateMonitorInput
} from "./src/validation.mjs";
import { parseProductContractText } from "@ai-product-reliability/standard/product-contract";
import { createStore } from "./src/stores/index.mjs";
import { startScheduler, runSchedulerOnce } from "./src/scheduler.mjs";
import { buildIncidentPackage } from "./src/incident.mjs";
import {
  acknowledgeIncident,
  assignIncident,
  createIncidentRecord,
  linkIncidentAlerts,
  reopenIncident,
  resolveIncident
} from "./src/incident-lifecycle.mjs";
import { buildPublicStatusModel } from "./src/public-status.mjs";
import { aggregateFleetStatus, deriveEnvironmentStatus } from "./src/status-model.mjs";
import { buildSystemPassport } from "./src/system-passport.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

export async function createDashboardServer(options = {}) {
  const config = { ...loadConfig(options.env ?? process.env), ...options.config };
  validateConfig(config);
  const store = await createStore(config, options);
  const security = createSecurity(config);

  const server = http.createServer(async (request, response) => {
    try {
      await route({ request, response, store, config, security });
    } catch (error) {
      const payload = { error: error.status ? error.message : "Internal server error" };
      if (error.status && error.code) payload.code = error.code;
      if (error.status && error.details) payload.details = error.details;
      sendJson(response, error.status ?? 500, payload, security.securityHeaders);
      if (!error.status) console.error(error);
    }
  });

  server.store = store;
  server.stopWorker = config.workerEnabled && config.processRole === "all" ? startScheduler(store, config) : null;
  let resourcesClosed = false;
  let shutdownPromise = null;
  const closeResources = async () => {
    if (resourcesClosed) return;
    resourcesClosed = true;
    await server.stopWorker?.();
    await store.close?.();
  };
  server.on("close", () => void closeResources());
  server.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = new Promise((resolve, reject) => {
      if (!server.listening) {
        closeResources().then(resolve, reject);
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else closeResources().then(resolve, reject);
      });
    });
    return shutdownPromise;
  };
  return server;
}

async function route(ctx) {
  const { request, response, store, config, security } = ctx;
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  applyCors(request, response, config);
  if (request.method === "OPTIONS") {
    response.writeHead(204, security.securityHeaders);
    response.end();
    return;
  }

  const rate = security.checkRateLimit(request, url);
  if (!rate.ok) throw httpError(429, "Too many requests");

  const auth = await security.authenticate(request, url, store);
  if (!auth.ok) throw httpError(auth.status, auth.error);
  ctx.principal = auth.principal;

  if (request.method === "GET" && url.pathname === "/healthz") {
    return sendJson(response, 200, { ok: true, time: new Date().toISOString() }, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    let readiness;
    try {
      readiness = await store.readiness();
    } catch {
      readiness = { ok: false, checks: { store: false, migrations: false } };
    }
    return sendJson(response, readiness.ok ? 200 : 503, readiness, security.securityHeaders);
  }

  if (request.method === "POST" && url.pathname === "/api/session/login") {
    const body = await readJsonBody(request, config);
    const session = await security.login(body);
    await appendAudit(store, {
      principal: { type: "anonymous" },
      sourceIp: rate.clientIp,
      action: session ? "session.login_succeeded" : "session.login_failed",
      targetType: "session",
      actorId: body.email ? hashIdentifier(body.email, config.userIdHmacSecret) : null
    });
    if (!session) throw httpError(401, "Invalid credentials");
    response.setHeader("set-cookie", `${security.SESSION_COOKIE}=${session}; ${cookieAttributes(config)}`);
    return sendJson(response, 200, { ok: true }, security.securityHeaders);
  }

  if (request.method === "POST" && url.pathname === "/api/product-contracts/validate") {
    ensureScope(security, ctx.principal, "admin");
    const body = await readJsonBody(request, config);
    if (typeof body.yaml !== "string" || !body.yaml.trim()) throw httpError(400, "yaml must be a non-empty string");
    try {
      return sendJson(response, 200, parseProductContractText(body.yaml, "imported product.yml"), security.securityHeaders);
    } catch (error) {
      const wrapped = httpError(error.status ?? 400, error.message);
      wrapped.code = error.code ?? "invalid_contract";
      wrapped.details = { issues: error.issues ?? [] };
      throw wrapped;
    }
  }

  const apiKeyRoute = parseApiKeyRoute(url.pathname);
  if (apiKeyRoute) return productApiKeyResponse({ ...ctx, url, rate, apiKeyRoute });

  if (request.method === "GET" && url.pathname === "/api/summary") {
    ensureScope(security, ctx.principal, "admin");
    return sendJson(response, 200, await store.summarize(), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/products") {
    ensureScope(security, ctx.principal, "read");
    return sendJson(response, 200, await store.listProducts(principalFilter(ctx.principal)), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    ensureScope(security, ctx.principal, "read");
    return sendJson(response, 200, await store.listEvents(200, principalFilter(ctx.principal)), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/errors") {
    ensureScope(security, ctx.principal, "read");
    return sendJson(response, 200, await store.listErrors(200, principalFilter(ctx.principal)), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    ensureScope(security, ctx.principal, "read");
    return sendJson(response, 200, await store.latestHealthByProduct(principalFilter(ctx.principal)), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, await publicStatusModel(store, config), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/incident-packages/")) {
    ensureScope(security, ctx.principal, "read");
    const productId = decodeURIComponent(url.pathname.split("/").pop());
    ensureProductAccess(ctx.principal, productId);
    return incidentPackageResponse(response, store, productId, url, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/compliance-scans") {
    ensureScope(security, ctx.principal, "read");
    const requestedProductId = url.searchParams.get("product_id") || undefined;
    if (requestedProductId) ensureProductAccess(ctx.principal, requestedProductId);
    const productId = ctx.principal.type === "project-key" ? ctx.principal.product_id : requestedProductId;
    return sendJson(response, 200, { items: await store.listComplianceScans({ productId }) }, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/audit-logs") {
    ensureScope(security, ctx.principal, "admin");
    const productId = url.searchParams.get("product_id") || undefined;
    return sendJson(response, 200, { items: await store.listAuditLogs({ productId }) }, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/operational-status") {
    ensureScope(security, ctx.principal, "read");
    const requestedProductId = url.searchParams.get("product_id") || undefined;
    const environment = url.searchParams.get("environment") || undefined;
    if (requestedProductId) ensureProductAccess(ctx.principal, requestedProductId);
    const productId = ctx.principal.type === "project-key" ? ctx.principal.product_id : requestedProductId;
    return sendJson(response, 200, await operationalStatusModel(store, config, { productId, environment }), security.securityHeaders);
  }
  const detailRoute = /^\/api\/products\/([^/]+)\/detail$/.exec(url.pathname);
  if (request.method === "GET" && detailRoute) {
    ensureScope(security, ctx.principal, "read");
    const productId = decodeURIComponent(detailRoute[1]);
    ensureProductAccess(ctx.principal, productId);
    return sendJson(response, 200, await productDetail(store, config, productId, url.searchParams.get("environment") ?? "production"), security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/incidents") {
    ensureScope(security, ctx.principal, "read");
    const requested = url.searchParams.get("product_id") || undefined;
    if (requested) ensureProductAccess(ctx.principal, requested);
    const productId = ctx.principal.type === "project-key" ? ctx.principal.product_id : requested;
    return sendJson(response, 200, { items: await store.listIncidents({ productId, environment: url.searchParams.get("environment") || undefined }) }, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/alert-instances") {
    ensureScope(security, ctx.principal, "read");
    const requested = url.searchParams.get("product_id") || undefined;
    if (requested) ensureProductAccess(ctx.principal, requested);
    const productId = ctx.principal.type === "project-key" ? ctx.principal.product_id : requested;
    return sendJson(response, 200, { items: await store.listAlertInstances({ productId, environment: url.searchParams.get("environment") || undefined }) }, security.securityHeaders);
  }
  if (request.method === "GET" && url.pathname === "/api/maintenance-windows") {
    ensureScope(security, ctx.principal, "read");
    const requested = url.searchParams.get("product_id") || undefined;
    if (requested) ensureProductAccess(ctx.principal, requested);
    const productId = ctx.principal.type === "project-key" ? ctx.principal.product_id : requested;
    return sendJson(response, 200, { items: await store.listMaintenanceWindows({ productId, environment: url.searchParams.get("environment") || undefined }) }, security.securityHeaders);
  }
  const passportRoute = /^\/api\/system-passports\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && passportRoute) {
    ensureScope(security, ctx.principal, "read");
    const productId = decodeURIComponent(passportRoute[1]);
    ensureProductAccess(ctx.principal, productId);
    const passport = await systemPassport(store, config, productId, url.searchParams.get("environment") ?? "production");
    if (!passport) throw httpError(404, "Product not found");
    return sendJson(response, 200, passport, security.securityHeaders);
  }

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    ensureScope(security, ctx.principal, "ingest");
    const validated = validateIngestBatch(await readJsonBody(request, config), config);
    const { items } = validated;
    for (const item of items) ensureProductAccess(ctx.principal, item.product_id);
    await ensureProductsForTelemetry(store, items);
    const stored = await store.appendIngestItems(items);
    return sendJson(response, 200, { ...stored, warnings: validated.warnings, migration_advice: validated.migration_advice }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/products") {
    ensureScope(security, ctx.principal, "admin");
    const body = normalizeProduct(await readJsonBody(request, config), config);
    const product = await store.upsertProduct(body);
    await appendAudit(store, {
      principal: ctx.principal,
      sourceIp: rate.clientIp,
      action: "product.upserted",
      targetType: "product",
      targetId: product.product_id,
      productId: product.product_id,
      metadata: { standard_version: product.standard_version, public_status_enabled: product.public_status_enabled === true }
    });
    return sendJson(response, 200, { ok: true, product }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/compliance-scans") {
    ensureScope(security, ctx.principal, "ingest");
    const scan = validateComplianceScan(await readJsonBody(request, config), config);
    ensureProductAccess(ctx.principal, scan.product_id);
    if (!(await store.getProduct(scan.product_id))) throw httpError(404, "Product not found");
    const created = await store.createComplianceScan(scan);
    await appendAudit(store, {
      principal: ctx.principal,
      sourceIp: rate.clientIp,
      action: "compliance_scan.created",
      targetType: "compliance_scan",
      targetId: created.id,
      productId: scan.product_id,
      metadata: { score: scan.score, max_score: scan.max_score, grade: scan.grade }
    });
    return sendJson(response, 201, { scan: created }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    const validated = [];
    for (const monitor of values) validated.push(await validateMonitorInput(monitor, config));
    await ensureExistingProducts(store, validated);
    const result = await store.appendMonitors(validated);
    for (const monitor of validated) {
      await appendAudit(store, {
        principal: ctx.principal,
        sourceIp: rate.clientIp,
        action: "monitor.registered",
        targetType: "monitor",
        targetId: monitor.id,
        productId: monitor.product_id
      });
    }
    return sendJson(response, 200, result, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/alerts") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    const validated = values.map((alert) => validateStructuredAlert(alert, config));
    await ensureExistingProducts(store, validated);
    const result = await store.appendAlerts(validated);
    for (const alert of validated) {
      await appendAudit(store, {
        principal: ctx.principal,
        sourceIp: rate.clientIp,
        action: "alert_rule.upserted",
        targetType: "alert_rule",
        targetId: alert.id,
        productId: alert.product_id,
        metadata: { type: alert.type, environment: alert.environment, severity: alert.severity ?? "medium" }
      });
    }
    return sendJson(response, 200, result, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/status-pages") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    const pages = values.map(validateStatusPageInput);
    await ensureExistingProducts(store, pages);
    const result = await store.appendStatusPages(pages);
    for (const page of pages) {
      await appendAudit(store, {
        principal: ctx.principal,
        sourceIp: rate.clientIp,
        action: "status_page.published",
        targetType: "status_page",
        targetId: page.public_slug,
        productId: page.product_id
      });
    }
    return sendJson(response, 200, result, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/scheduler/run-once") {
    ensureScope(security, ctx.principal, "admin");
    const lease = store.withSchedulerLease
      ? await store.withSchedulerLease(() => runSchedulerOnce(store, config))
      : { acquired: true, value: await runSchedulerOnce(store, config) };
    if (!lease.acquired) throw httpError(409, "Scheduler is already running");
    const result = lease.value;
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "scheduler.run_once", targetType: "scheduler" });
    return sendJson(response, 200, result, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/incidents") {
    ensureScope(security, ctx.principal, "admin");
    const body = await readJsonBody(request, config);
    if (!(await store.getProduct(body.product_id))) throw httpError(404, "Product not found");
    const incident = createIncidentRecord(body, { actor: body.actor ?? principalActor(ctx.principal) });
    const created = await store.createIncident(incident);
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "incident.created", targetType: "incident", targetId: created.id, productId: created.product_id, metadata: { environment: created.environment, severity: created.severity } });
    return sendJson(response, 201, { incident: created }, security.securityHeaders);
  }
  const incidentAction = /^\/api\/incidents\/([^/]+)\/(acknowledge|assign|link-alerts|resolve|reopen)$/.exec(url.pathname);
  if (request.method === "POST" && incidentAction) {
    ensureScope(security, ctx.principal, "admin");
    const id = decodeURIComponent(incidentAction[1]);
    const current = await store.getIncident(id);
    if (!current) throw httpError(404, "Incident not found");
    const body = await readJsonBody(request, config);
    const actor = body.actor ?? principalActor(ctx.principal);
    let incident;
    if (incidentAction[2] === "acknowledge") incident = acknowledgeIncident(current, { actor });
    else if (incidentAction[2] === "assign") incident = assignIncident(current, body.owner, { actor });
    else if (incidentAction[2] === "link-alerts") incident = linkIncidentAlerts(current, body.alert_ids, { actor });
    else if (incidentAction[2] === "resolve") incident = resolveIncident(current, { recovery_note: body.recovery_note, actor });
    else incident = reopenIncident(current, { reason: body.reason, actor });
    const updated = await store.updateIncident(incident);
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: `incident.${incidentAction[2]}`, targetType: "incident", targetId: updated.id, productId: updated.product_id, metadata: { environment: updated.environment, status: updated.status } });
    return sendJson(response, 200, { incident: updated }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/maintenance-windows") {
    ensureScope(security, ctx.principal, "admin");
    const body = validateMaintenanceWindow(await readJsonBody(request, config));
    if (!(await store.getProduct(body.product_id))) throw httpError(404, "Product not found");
    const maintenanceWindow = await store.createMaintenanceWindow(body);
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "maintenance_window.created", targetType: "maintenance_window", targetId: maintenanceWindow.id, productId: body.product_id, metadata: { environment: body.environment, starts_at: body.starts_at, ends_at: body.ends_at } });
    return sendJson(response, 201, { maintenance_window: maintenanceWindow }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/retention/run") {
    ensureScope(security, ctx.principal, "admin");
    const result = await store.runRetention({ rawRetentionDays: config.rawRetentionDays }, new Date());
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "retention.run", targetType: "retention", metadata: { cutoff: result.cutoff, deleted: result.deleted } });
    return sendJson(response, 200, result, security.securityHeaders);
  }
  const alertAction = /^\/api\/alert-instances\/([^/]+)\/acknowledge$/.exec(url.pathname);
  if (request.method === "POST" && alertAction) {
    ensureScope(security, ctx.principal, "admin");
    const body = await readJsonBody(request, config);
    const alert = await store.acknowledgeAlertInstance(decodeURIComponent(alertAction[1]), { actor: body.actor ?? principalActor(ctx.principal) });
    if (!alert) throw httpError(404, "Alert not found");
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "alert_instance.acknowledged", targetType: "alert_instance", targetId: alert.id, productId: alert.product_id, metadata: { environment: alert.environment } });
    return sendJson(response, 200, { alert }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/incident-packages/")) {
    ensureScope(security, ctx.principal, "admin");
    const productId = decodeURIComponent(url.pathname.split("/").pop());
    const incident = await buildIncidentPackage(store, productId);
    const created = await store.createIncident(incident);
    await appendAudit(store, { principal: ctx.principal, sourceIp: rate.clientIp, action: "incident_package.created", targetType: "incident", targetId: created.id, productId });
    return sendJson(response, 200, created, security.securityHeaders);
  }

  if (request.method === "GET" && url.pathname.startsWith("/status")) return serveStatusPage(response, store, url, security.securityHeaders, config);
  if (request.method === "GET") return serveStatic(response, url.pathname, security.securityHeaders);

  throw httpError(405, "Method not allowed");
}

async function ensureProductsForTelemetry(store, items) {
  for (const item of items) {
    if (item.type === "product") continue;
    if (!(await store.getProduct(item.product_id))) {
      await store.upsertProduct({
        product_id: item.product_id,
        name: item.product_id,
        owner: "unknown",
        standard_version: "unknown",
        environments: [],
        critical_journeys: [],
        contract: {}
      });
    }
  }
}

async function ensureExistingProducts(store, items) {
  for (const productId of new Set(items.map((item) => item.product_id))) {
    if (!(await store.getProduct(productId))) throw httpError(404, "Product not found");
  }
}

async function productApiKeyResponse(ctx) {
  const { request, response, store, config, security, principal, apiKeyRoute, rate } = ctx;
  ensureScope(security, principal, "admin");
  const { productId, keyId, action } = apiKeyRoute;
  const product = await store.getProduct(productId);
  if (!product) throw httpError(404, "Product not found");

  if (request.method === "GET" && !keyId) {
    const items = (await store.listApiKeys(productId)).map(publicApiKey);
    return sendJson(response, 200, { items }, security.securityHeaders);
  }

  if (request.method === "POST" && !keyId) {
    const input = validateApiKeyRequest(await readJsonBody(request, config));
    const secret = createApiKeySecret();
    const apiKey = await store.createApiKey({
      product_id: productId,
      name: input.name,
      key_hash: hashSecret(secret),
      scopes: input.scopes,
      expires_at: input.expires_at
    });
    await appendAudit(store, {
      principal,
      sourceIp: rate.clientIp,
      action: "api_key.created",
      targetType: "api_key",
      targetId: apiKey.id,
      productId,
      metadata: { name: apiKey.name, scopes: apiKey.scopes, expires_at: apiKey.expires_at }
    });
    return sendJson(response, 201, { api_key: publicApiKey(apiKey), secret }, security.securityHeaders);
  }

  const current = keyId ? await store.getApiKey(keyId, productId) : null;
  if (!current) throw httpError(404, "API key not found");

  if (request.method === "POST" && action === "rotate") {
    const body = await readJsonBody(request, config);
    const input = validateApiKeyRequest({
      name: body.name ?? current.name,
      scopes: body.scopes ?? current.scopes,
      expires_at: body.expires_at ?? current.expires_at
    });
    const secret = createApiKeySecret();
    const apiKey = await store.rotateApiKey(keyId, productId, {
      name: input.name,
      key_hash: hashSecret(secret),
      scopes: input.scopes,
      expires_at: input.expires_at
    });
    if (!apiKey) throw httpError(409, "API key is already revoked");
    await appendAudit(store, {
      principal,
      sourceIp: rate.clientIp,
      action: "api_key.rotated",
      targetType: "api_key",
      targetId: apiKey.id,
      productId,
      metadata: { rotated_from_id: keyId }
    });
    return sendJson(response, 201, { api_key: publicApiKey(apiKey), secret }, security.securityHeaders);
  }

  if (request.method === "POST" && action === "revoke") {
    const apiKey = await store.revokeApiKey(keyId, productId);
    await appendAudit(store, {
      principal,
      sourceIp: rate.clientIp,
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: keyId,
      productId
    });
    return sendJson(response, 200, { api_key: publicApiKey(apiKey) }, security.securityHeaders);
  }

  throw httpError(405, "Method not allowed");
}

function parseApiKeyRoute(pathname) {
  const match = /^\/api\/products\/([^/]+)\/api-keys(?:\/([^/]+)\/(rotate|revoke))?$/.exec(pathname);
  if (!match) return null;
  return {
    productId: decodeURIComponent(match[1]),
    keyId: match[2] ? decodeURIComponent(match[2]) : null,
    action: match[3] ?? null
  };
}

function publicApiKey(apiKey) {
  const { key_hash: _keyHash, ...safe } = apiKey;
  return safe;
}

function principalFilter(principal) {
  return principal?.type === "project-key" ? { productId: principal.product_id } : {};
}

function ensureProductAccess(principal, productId) {
  if (principal?.type === "project-key" && principal.product_id !== productId) {
    throw httpError(403, "Forbidden for this product");
  }
}

async function appendAudit(store, {
  principal,
  sourceIp,
  action,
  targetType,
  targetId = null,
  productId = null,
  actorId = null,
  metadata = {}
}) {
  if (!store.appendAuditLog) return;
  await store.appendAuditLog({
    product_id: productId,
    actor_type: principal?.type ?? "unknown",
    actor_id: actorId ?? principal?.product_id ?? null,
    action,
    target_type: targetType,
    target_id: targetId,
    source_ip: sourceIp,
    metadata
  });
}

function ensureScope(security, principal, scope) {
  if (!security.authorize(principal, scope)) throw httpError(403, "Forbidden");
}

async function itemArrayBody(request, config) {
  const body = await readJsonBody(request, config);
  return Array.isArray(body.items) ? body.items : [body];
}

async function incidentPackageResponse(response, store, productId, url, headers) {
  const incident = await buildIncidentPackage(store, productId);
  if (url.searchParams.get("format") === "md") {
    response.writeHead(200, { ...headers, "content-type": "text/markdown; charset=utf-8" });
    response.end(incident.package_markdown);
    return;
  }
  sendJson(response, 200, incident, headers);
}

async function operationalStatusModel(store, config, { productId, environment, now = new Date() } = {}) {
  const products = await store.listProducts({ productId });
  const items = [];
  for (const product of products) {
    const environments = environment ? [environment] : declaredEnvironments(product);
    for (const currentEnvironment of environments) {
      const [healthChecks, configuredMonitors, monitorRuns, activeAlerts, incidents] = await Promise.all([
        store.listHealth({ productId: product.product_id, environment: currentEnvironment, limit: 500 }),
        store.listMonitors({ productId: product.product_id, environment: currentEnvironment }),
        store.listMonitorRuns({ productId: product.product_id, environment: currentEnvironment, limit: 500 }),
        store.listAlertInstances({ productId: product.product_id, environment: currentEnvironment }),
        store.listIncidents({ productId: product.product_id, environment: currentEnvironment })
      ]);
      items.push({
        product_id: product.product_id,
        product_name: product.name,
        environment: currentEnvironment,
        ...deriveEnvironmentStatus({
          productId: product.product_id,
          environment: currentEnvironment,
          healthChecks,
          configuredMonitors,
          monitorRuns,
          activeAlerts,
          incidents,
          now,
          staleAfterMs: config.telemetryStaleAfterMs ?? 5 * 60_000
        })
      });
    }
  }
  return { status: aggregateFleetStatus(items), generated_at: now.toISOString(), items };
}

async function publicStatusModel(store, config) {
  const products = await store.listProducts();
  const operational = await operationalStatusModel(store, config);
  const pages = await store.listStatusPages();
  return buildPublicStatusModel({ products, statuses: operational.items, statusPages: pages });
}

async function productDetail(store, config, productId, environment) {
  const product = await store.getProduct(productId);
  if (!product) throw httpError(404, "Product not found");
  const [status, releases, monitors, monitorRuns, errors, events, alerts, incidents] = await Promise.all([
    operationalStatusModel(store, config, { productId, environment }),
    store.listReleases(100, { productId, environment }),
    store.listMonitors({ productId, environment }),
    store.listMonitorRuns({ productId, environment, limit: 200 }),
    store.listErrors(200, { productId, environment }),
    store.listEvents(200, { productId, environment }),
    store.listAlertInstances({ productId, environment }),
    store.listIncidents({ productId, environment })
  ]);
  return {
    product,
    environment,
    status: status.items[0] ?? { status: "unknown", reasons: [] },
    latest_release: releases[0] ?? null,
    releases,
    monitors,
    monitor_runs: monitorRuns,
    errors,
    events,
    journeys: product.critical_journeys ?? [],
    alerts,
    incidents
  };
}

async function systemPassport(store, config, productId, environment) {
  const product = await store.getProduct(productId);
  if (!product) return null;
  const [status, scans, releases, monitors, runs] = await Promise.all([
    operationalStatusModel(store, config, { productId, environment }),
    store.listComplianceScans({ productId, limit: 1 }),
    store.listReleases(1, { productId, environment }),
    store.listMonitors({ productId, environment }),
    store.listMonitorRuns({ productId, environment, limit: 200 })
  ]);
  const latestRuns = new Map();
  for (const run of runs) if (!latestRuns.has(run.monitor_id)) latestRuns.set(run.monitor_id, run);
  return buildSystemPassport({
    product,
    environment,
    scan: scans[0],
    runtime: {
      status: status.items[0],
      latest_release: releases[0],
      monitors: monitors.map((monitor) => ({ ...monitor, ...(latestRuns.get(monitor.id) ?? {}) }))
    },
    staleAfterMs: config.telemetryStaleAfterMs
  });
}

async function serveStatusPage(response, store, url, headers, config) {
  const slug = url.pathname === "/status" ? null : decodeURIComponent(url.pathname.replace(/^\/status\/?/, ""));
  const status = await publicStatusModel(store, config);
  const products = slug ? status.products.filter((product) => product.slug === slug) : status.products;
  if (slug && !products.length) throw httpError(404, "Public status page not found");
  const title = slug ? products[0].name : "System Status";
  const body = products.length
    ? products.map((product) => `<article class="row-item"><strong>${escapeHtml(product.name)}</strong><div class="meta">${escapeHtml(product.status)} · ${escapeHtml(product.summary)}</div>${product.components.map((component) => `<div>${escapeHtml(component.name)}: ${escapeHtml(component.status)}</div>`).join("")}</article>`).join("")
    : `<div class="row-item">No products are published.</div>`;
  const pageStatus = slug ? products[0].status : status.status;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell"><header class="topbar"><div><p class="eyebrow">Public Status</p><h1>${escapeHtml(title)}</h1></div><div class="status-pill ${pageStatus}">${escapeHtml(pageStatus)}</div></header><section class="panel status-body">${body}</section></main></body></html>`;
  response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function validateStructuredAlert(input, config) {
  const supported = new Set(["availability_failure", "telemetry_stale", "error_spike", "journey_drop"]);
  if (!input || typeof input !== "object" || Array.isArray(input) || !supported.has(input.type)) throw httpError(400, "Unsupported structured alert type");
  for (const field of ["id", "product_id", "environment", "name"]) {
    validateText(input[field], `Alert ${field}`, field === "id" ? 256 : field === "name" ? 256 : 128);
  }
  if (config.allowedEnvironments?.length && !config.allowedEnvironments.includes(input.environment)) {
    throw httpError(400, `Unsupported environment: ${input.environment}`);
  }
  if (input.enabled != null && typeof input.enabled !== "boolean") throw httpError(400, "Alert enabled must be a boolean");
  const severity = String(input.severity ?? "medium").toLowerCase();
  if (!new Set(["low", "medium", "high", "critical"]).has(severity)) throw httpError(400, "Alert severity must be low, medium, high, or critical");
  validateOptionalInteger(input.cooldown_seconds, "cooldown_seconds", 1, 604_800);
  validateOptionalInteger(input.recovery_threshold, "recovery_threshold", 1, 100);
  if (input.type === "availability_failure") {
    validateText(input.monitor_id, "availability_failure monitor_id", 256);
    validateOptionalInteger(input.consecutive_failures, "consecutive_failures", 1, 100);
  }
  if (input.type === "telemetry_stale") {
    validateOptionalInteger(input.stale_after_seconds, "stale_after_seconds", 1, 604_800);
    validateOptionalInteger(input.window_seconds, "window_seconds", 1, 604_800);
  }
  if (input.type === "error_spike") {
    validateOptionalInteger(input.window_seconds, "window_seconds", 1, 604_800);
    validateOptionalInteger(input.min_samples, "min_samples", 1, 1_000_000);
    validateOptionalNumber(input.multiplier, "multiplier", 0.01, 100);
  }
  if (input.type === "journey_drop") {
    validateText(input.event, "journey_drop event", 128);
    validateOptionalInteger(input.window_seconds, "window_seconds", 1, 604_800);
    validateOptionalInteger(input.min_samples, "min_samples", 1, 1_000_000);
    validateOptionalNumber(input.drop_percent, "drop_percent", 0.01, 100);
  }
  return { enabled: true, ...input, severity };
}

function validateStatusPageInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw httpError(400, "Status page must be an object");
  const productId = validateText(input.product_id, "Status page product_id", 128);
  const publicSlug = input.public_slug ?? productId;
  if (typeof publicSlug !== "string" || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(publicSlug)) {
    throw httpError(400, "Status page public_slug must contain only lowercase letters, numbers, and hyphens");
  }
  const title = input.title == null ? `${productId} status` : validateText(input.title, "Status page title", 256);
  if (input.body != null && (typeof input.body !== "string" || input.body.length > 20_000)) throw httpError(400, "Status page body is invalid");
  if (input.public_summary != null && (typeof input.public_summary !== "string" || input.public_summary.length > 500)) throw httpError(400, "Status page public_summary is invalid");
  if (input.components != null) {
    if (!Array.isArray(input.components) || input.components.length > 50) throw httpError(400, "Status page components must contain at most 50 items");
    for (const component of input.components) {
      validateText(component?.name, "Status page component name", 120);
      if (!["unknown", "operational", "degraded", "outage"].includes(component?.status)) {
        throw httpError(400, "Status page component status is invalid");
      }
    }
  }
  if (input.generated_at != null && !Number.isFinite(Date.parse(input.generated_at))) throw httpError(400, "Status page generated_at is invalid");
  return { components: [], ...input, product_id: productId, public_slug: publicSlug, title };
}

function validateText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw httpError(400, `${field} must be a non-empty string up to ${maxLength} characters`);
  }
  return value.trim();
}

function validateOptionalInteger(value, field, min, max) {
  if (value == null) return;
  if (!Number.isInteger(value) || value < min || value > max) throw httpError(400, `${field} must be an integer between ${min} and ${max}`);
}

function validateOptionalNumber(value, field, min, max) {
  if (value == null) return;
  if (!Number.isFinite(value) || value < min || value > max) throw httpError(400, `${field} must be a number between ${min} and ${max}`);
}

function validateMaintenanceWindow(input) {
  for (const field of ["product_id", "environment", "name", "starts_at", "ends_at"]) {
    if (!String(input?.[field] ?? "").trim()) throw httpError(400, `Maintenance window ${field} is required`);
  }
  const starts = Date.parse(input.starts_at);
  const ends = Date.parse(input.ends_at);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || ends <= starts) throw httpError(400, "Maintenance window end must follow start");
  return { ...input, starts_at: new Date(starts).toISOString(), ends_at: new Date(ends).toISOString() };
}

function declaredEnvironments(product) {
  const environments = (product.environments ?? []).map((item) => typeof item === "string" ? item : item.name).filter(Boolean);
  return environments.length ? [...new Set(environments)] : ["production"];
}

function principalActor(principal) {
  return principal?.product_id ?? principal?.type ?? "system";
}

async function readJsonBody(request, config) {
  let size = 0;
  let body = "";
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw httpError(413, "Request body too large");
    body += chunk;
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw httpError(400, "Malformed JSON body");
  }
}

async function serveStatic(response, urlPath, headers) {
  const filePath = urlPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, urlPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(publicDir)) throw httpError(403, "Forbidden");
  try {
    const data = await fs.readFile(resolved);
    response.writeHead(200, { ...headers, "content-type": contentType(resolved) });
    response.end(data);
  } catch {
    throw httpError(404, "Not found");
  }
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { ...headers, "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function cookieAttributes(config) {
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=28800",
    config.nodeEnv === "production" ? "Secure" : null
  ].filter(Boolean).join("; ");
}

function applyCors(request, response, config) {
  const origin = request.headers.origin;
  if (!origin) return;
  if (config.corsOrigins.includes(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-apr-api-key");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

function markdownToHtml(markdown) {
  return escapeHtml(markdown)
    .replace(/^# (.+)$/gm, "<h2>$1</h2>")
    .replace(/^## (.+)$/gm, "<h3>$1</h3>")
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = await createDashboardServer({ config });
  server.listen(config.port, config.host, () => {
    console.log(`AI Product Reliability Dashboard: http://${config.host}:${config.port}`);
  });
  const shutdown = async (signal) => {
    console.log(`AI Product Reliability Dashboard received ${signal}`);
    const force = setTimeout(() => server.closeAllConnections?.(), config.gracefulShutdownMs);
    force.unref?.();
    try {
      await server.shutdown();
      clearTimeout(force);
      process.exit(0);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
