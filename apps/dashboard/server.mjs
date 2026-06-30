#!/usr/bin/env node
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./src/config.mjs";
import { createSecurity } from "./src/security.mjs";
import { validateIngestBody, normalizeProduct, httpError } from "./src/validation.mjs";
import { createStore } from "./src/stores/index.mjs";
import { startScheduler, runSchedulerOnce } from "./src/scheduler.mjs";
import { buildIncidentPackage } from "./src/incident.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

export async function createDashboardServer(options = {}) {
  const config = { ...loadConfig(options.env ?? process.env), ...options.config };
  const store = await createStore(config, options);
  const security = createSecurity(config);

  const server = http.createServer(async (request, response) => {
    try {
      await route({ request, response, store, config, security });
    } catch (error) {
      sendJson(response, error.status ?? 500, { error: error.status ? error.message : "Internal server error" }, security.securityHeaders);
      if (!error.status) console.error(error);
    }
  });

  server.store = store;
  server.stopWorker = config.workerEnabled ? startScheduler(store, config) : null;
  server.on("close", () => {
    server.stopWorker?.();
    store.close?.();
  });
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

  const rate = security.checkRateLimit(request);
  if (!rate.ok) throw httpError(429, "Too many requests");

  const auth = await security.authenticate(request, url, store);
  if (!auth.ok) throw httpError(auth.status, auth.error);
  ctx.principal = auth.principal;

  if (request.method === "POST" && url.pathname === "/api/session/login") {
    const session = await security.login(await readJsonBody(request, config));
    if (!session) throw httpError(401, "Invalid credentials");
    response.setHeader("set-cookie", `${security.SESSION_COOKIE}=${session}; ${cookieAttributes(config)}`);
    return sendJson(response, 200, { ok: true }, security.securityHeaders);
  }

  if (request.method === "GET" && url.pathname === "/api/summary") return sendJson(response, 200, await store.summarize(), security.securityHeaders);
  if (request.method === "GET" && url.pathname === "/api/products") return sendJson(response, 200, await store.listProducts(), security.securityHeaders);
  if (request.method === "GET" && url.pathname === "/api/events") return sendJson(response, 200, await store.listEvents(), security.securityHeaders);
  if (request.method === "GET" && url.pathname === "/api/errors") return sendJson(response, 200, await store.listErrors(), security.securityHeaders);
  if (request.method === "GET" && url.pathname === "/api/health") return sendJson(response, 200, await store.latestHealthByProduct(), security.securityHeaders);
  if (request.method === "GET" && url.pathname === "/api/status") return sendJson(response, 200, await statusModel(store), security.securityHeaders);
  if (request.method === "GET" && url.pathname.startsWith("/api/incident-packages/")) return incidentPackageResponse(response, store, decodeURIComponent(url.pathname.split("/").pop()), url, security.securityHeaders);

  if (request.method === "POST" && url.pathname === "/api/ingest") {
    ensureScope(security, ctx.principal, "ingest");
    const items = validateIngestBody(await readJsonBody(request, config), config);
    await ensureProductsForTelemetry(store, items);
    return sendJson(response, 200, await store.appendIngestItems(items), security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/products") {
    ensureScope(security, ctx.principal, "ingest");
    const body = normalizeProduct(await readJsonBody(request, config));
    return sendJson(response, 200, { ok: true, product: await store.upsertProduct(body) }, security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    return sendJson(response, 200, await store.appendMonitors(values), security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/alerts") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    return sendJson(response, 200, await store.appendAlerts(values), security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/status-pages") {
    ensureScope(security, ctx.principal, "admin");
    const values = await itemArrayBody(request, config);
    return sendJson(response, 200, await store.appendStatusPages(values.map((page) => ({ public_slug: page.public_slug ?? page.product_id, ...page }))), security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname === "/api/scheduler/run-once") {
    ensureScope(security, ctx.principal, "admin");
    return sendJson(response, 200, await runSchedulerOnce(store, config), security.securityHeaders);
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/incident-packages/")) {
    ensureScope(security, ctx.principal, "admin");
    const productId = decodeURIComponent(url.pathname.split("/").pop());
    const incident = await buildIncidentPackage(store, productId);
    return sendJson(response, 200, await store.createIncident(incident), security.securityHeaders);
  }

  if (request.method === "GET" && url.pathname.startsWith("/status")) return serveStatusPage(response, store, url, security.securityHeaders);
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

async function statusModel(store) {
  const products = await store.listProducts();
  const summary = await store.summarize();
  return {
    status: summary.status,
    generated_at: new Date().toISOString(),
    products: products.map((product) => ({
      product_id: product.product_id,
      name: product.name,
      status: summary.latest_health[product.product_id]?.payload?.ok === false ? "degraded" : "operational"
    }))
  };
}

async function serveStatusPage(response, store, url, headers) {
  const slug = url.pathname === "/status" ? null : decodeURIComponent(url.pathname.replace(/^\/status\/?/, ""));
  const status = await statusModel(store);
  const page = slug ? await store.getStatusPage(slug) : null;
  const title = page?.title ?? "System Status";
  const body = page?.body ? markdownToHtml(page.body) : status.products.map((product) => `<li>${escapeHtml(product.name)}: ${escapeHtml(product.status)}</li>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/styles.css"></head><body><main class="shell"><header class="topbar"><div><p class="eyebrow">Public Status</p><h1>${escapeHtml(title)}</h1></div><div class="status-pill ${status.status}">${escapeHtml(status.status)}</div></header><section class="panel status-body">${body}</section></main></body></html>`;
  response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

async function readJsonBody(request, config) {
  let size = 0;
  let body = "";
  for await (const chunk of request) {
    size += chunk.length;
    if (size > config.maxBodyBytes) throw httpError(413, "Request body too large");
    body += chunk;
  }
  return body ? JSON.parse(body) : {};
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
}
