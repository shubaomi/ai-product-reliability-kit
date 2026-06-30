#!/usr/bin/env node
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const defaultStorePath = path.join(__dirname, "data", "store.json");

const initialStore = {
  products: [],
  events: [],
  errors: [],
  health: [],
  releases: [],
  monitors: [],
  alerts: [],
  statusPages: []
};

export async function createDashboardServer(options = {}) {
  const storePath = options.storePath ?? process.env.APR_DASHBOARD_STORE ?? defaultStorePath;
  await ensureStore(storePath);

  return http.createServer(async (request, response) => {
    try {
      await route(request, response, storePath);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
  });
}

async function route(request, response, storePath) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && url.pathname === "/api/summary") {
    return sendJson(response, 200, summarize(await readStore(storePath)));
  }
  if (request.method === "GET" && url.pathname === "/api/products") {
    return sendJson(response, 200, (await readStore(storePath)).products);
  }
  if (request.method === "GET" && url.pathname === "/api/events") {
    return sendJson(response, 200, (await readStore(storePath)).events.slice(-200).reverse());
  }
  if (request.method === "GET" && url.pathname === "/api/errors") {
    return sendJson(response, 200, (await readStore(storePath)).errors.slice(-200).reverse());
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, latestByProduct((await readStore(storePath)).health));
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    return sendJson(response, 200, statusModel(await readStore(storePath)));
  }
  if (request.method === "POST" && url.pathname === "/api/ingest") {
    const body = await readJsonBody(request);
    const items = Array.isArray(body.items) ? body.items : [body];
    const store = await readStore(storePath);
    for (const item of items) appendIngestItem(store, item);
    await writeStore(storePath, store);
    return sendJson(response, 200, { accepted: items.length });
  }
  if (request.method === "POST" && url.pathname === "/api/products") {
    const body = await readJsonBody(request);
    const store = await readStore(storePath);
    upsertProduct(store, normalizeProduct(body));
    await writeStore(storePath, store);
    return sendJson(response, 200, { ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/monitors") {
    return appendCollection(request, response, storePath, "monitors");
  }
  if (request.method === "POST" && url.pathname === "/api/alerts") {
    return appendCollection(request, response, storePath, "alerts");
  }
  if (request.method === "POST" && url.pathname === "/api/status-pages") {
    return appendCollection(request, response, storePath, "statusPages");
  }

  if (request.method === "GET") {
    return serveStatic(response, url.pathname);
  }

  sendJson(response, 405, { error: "Method not allowed" });
}

async function appendCollection(request, response, storePath, key) {
  const body = await readJsonBody(request);
  const values = Array.isArray(body.items) ? body.items : [body];
  const store = await readStore(storePath);
  store[key].push(...values);
  await writeStore(storePath, store);
  sendJson(response, 200, { accepted: values.length });
}

function appendIngestItem(store, item) {
  if (!item?.type) return;
  if (item.type === "product") {
    upsertProduct(store, normalizeProduct(item.payload?.contract ?? item.payload ?? item));
  } else if (item.type === "event") {
    store.events.push(item);
  } else if (item.type === "error") {
    store.errors.push(item);
  } else if (item.type === "health") {
    store.health.push(item);
  } else if (item.type === "release") {
    store.releases.push(item);
  }
}

function normalizeProduct(input) {
  const contract = input?.contract ?? input;
  const product = contract?.product ?? contract;
  return {
    product_id: product?.id ?? input?.product_id ?? "unknown-product",
    name: product?.name ?? input?.name ?? product?.id ?? "Unknown Product",
    owner: product?.owner ?? input?.owner ?? "unknown",
    standard_version: contract?.standard_version ?? input?.standard_version ?? "unknown",
    environments: contract?.environments ?? input?.environments ?? [],
    critical_journeys: contract?.critical_journeys ?? input?.critical_journeys ?? [],
    updated_at: new Date().toISOString()
  };
}

function upsertProduct(store, product) {
  const index = store.products.findIndex((item) => item.product_id === product.product_id);
  if (index >= 0) store.products[index] = { ...store.products[index], ...product };
  else store.products.push(product);
}

function summarize(store) {
  const latestHealth = latestByProduct(store.health);
  const failingProducts = Object.values(latestHealth).filter((item) => item.payload?.ok === false).length;
  const eventsByProduct = countBy(store.events, "product_id");
  const errorsByProduct = countBy(store.errors, "product_id");
  return {
    products: store.products.length,
    events: store.events.length,
    errors: store.errors.length,
    releases: store.releases.length,
    monitors: store.monitors.length,
    alerts: store.alerts.length,
    failing_products: failingProducts,
    latest_health: latestHealth,
    events_by_product: eventsByProduct,
    errors_by_product: errorsByProduct,
    recent_events: store.events.slice(-20).reverse(),
    recent_errors: store.errors.slice(-20).reverse(),
    status: failingProducts ? "degraded" : "operational"
  };
}

function statusModel(store) {
  const summary = summarize(store);
  return {
    status: summary.status,
    generated_at: new Date().toISOString(),
    products: store.products.map((product) => ({
      product_id: product.product_id,
      name: product.name,
      status: summary.latest_health[product.product_id]?.payload?.ok === false ? "degraded" : "operational"
    }))
  };
}

function latestByProduct(items) {
  const latest = {};
  for (const item of items) latest[item.product_id] = item;
  return latest;
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] ?? "unknown";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

async function ensureStore(storePath) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  try {
    await fs.access(storePath);
  } catch {
    await writeStore(storePath, initialStore);
  }
}

async function readStore(storePath) {
  const text = await fs.readFile(storePath, "utf8");
  return { ...initialStore, ...JSON.parse(text) };
}

async function writeStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function serveStatic(response, urlPath) {
  const filePath = urlPath === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, urlPath);
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(publicDir)) {
    return sendJson(response, 403, { error: "Forbidden" });
  }
  try {
    const data = await fs.readFile(resolved);
    response.writeHead(200, { "content-type": contentType(resolved) });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".js")) return "text/javascript";
  if (filePath.endsWith(".html")) return "text/html";
  return "application/octet-stream";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const server = await createDashboardServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`AI Product Reliability Dashboard: http://127.0.0.1:${port}`);
  });
}

