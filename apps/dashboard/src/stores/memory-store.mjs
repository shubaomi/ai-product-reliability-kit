import crypto from "node:crypto";
import { acknowledgeAlert } from "../alert-rules.mjs";
import { rollupAndPrune } from "../retention.mjs";
import { aggregateFleetStatus, deriveEnvironmentStatus } from "../status-model.mjs";
import { normalizeProduct } from "../validation.mjs";

export function createEmptyState() {
  return {
    products: [],
    events: [],
    errors: [],
    health: [],
    releases: [],
    monitors: [],
    monitorRuns: [],
    alerts: [],
    alertInstances: [],
    alertDeliveries: [],
    maintenanceWindows: [],
    statusPages: [],
    incidents: [],
    apiKeys: [],
    complianceScans: [],
    auditLogs: [],
    dailyAggregates: [],
    ingestDedup: []
  };
}

export class MemoryStore {
  constructor(state = createEmptyState()) {
    this.state = { ...createEmptyState(), ...state };
    this.state.ingestDedup = normalizeDedupEntries(this.state);
    this.schedulerLeaseHeld = false;
  }

  async ready() { return true; }
  async close() {}

  async readiness() {
    return { ok: true, checks: { store: true, migrations: true } };
  }

  async upsertProduct(input) {
    const product = normalizeProduct(input);
    const collidingPage = this.state.statusPages.find((page) => page.public_slug === product.product_id && page.product_id !== product.product_id);
    if (collidingPage) throw conflictError(409, `Product ${product.product_id} conflicts with another product's public status slug`);
    const now = new Date().toISOString();
    const existing = this.state.products.findIndex((item) => item.product_id === product.product_id);
    const value = {
      ...(existing >= 0 ? this.state.products[existing] : { created_at: now }),
      ...product,
      public_status_enabled: product.public_status_enabled ?? product.contract?.public_status?.enabled === true,
      updated_at: now
    };
    if (existing >= 0) this.state.products[existing] = value;
    else this.state.products.push(value);
    return { ...value };
  }

  async appendIngestItems(items) {
    const duplicates = new Set();
    const projectedDedup = new Map(this.state.ingestDedup.map((entry) => [entry.key, entry.item_type]));
    for (const [index, item] of items.entries()) {
      if (!["product", "event", "error", "health", "release"].includes(item.type)) {
        throw conflictError(400, `Unsupported telemetry type: ${item.type}`);
      }
      if (item.type === "product") {
        const product = normalizeProduct(item.payload?.contract ?? item.payload ?? item);
        if (product.product_id !== item.product_id) throw conflictError(400, "Product envelope product_id must match payload contract product.id");
        const collidingPage = this.state.statusPages.find((page) => page.public_slug === product.product_id && page.product_id !== product.product_id);
        if (collidingPage) throw conflictError(409, `Product ${product.product_id} conflicts with another product's public status slug`);
      }
      const key = ingestDedupKey(item);
      if (!key) continue;
      if (projectedDedup.has(key)) {
        const existingType = projectedDedup.get(key);
        if (existingType && existingType !== item.type) {
          throw conflictError(409, `Idempotency key is already used for telemetry type ${existingType}`);
        }
        duplicates.add(index);
      } else projectedDedup.set(key, item.type);
    }

    let accepted = 0;
    for (const [index, item] of items.entries()) {
      if (duplicates.has(index)) continue;
      const dedupKey = ingestDedupKey(item);
      let stored = true;
      if (item.type === "product") {
        const product = normalizeProduct(item.payload?.contract ?? item.payload ?? item);
        if (product.product_id !== item.product_id) throw conflictError(400, "Product envelope product_id must match payload contract product.id");
        await this.upsertProduct(product);
      } else if (item.type === "event") {
        this.state.events.push({ ...item, event_name: item.payload?.event });
      } else if (item.type === "error") {
        this.state.errors.push({ ...item, error_name: item.payload?.name, message: item.payload?.message });
      } else if (item.type === "health") {
        this.state.health.push({ ...item });
      } else if (item.type === "release") {
        const existing = this.state.releases.findIndex((entry) => (
          entry.product_id === item.product_id
          && entry.environment === item.environment
          && (entry.payload?.version ?? entry.release) === (item.payload?.version ?? item.release)
        ));
        if (existing >= 0) this.state.releases[existing] = { ...item };
        else this.state.releases.push({ ...item });
      } else stored = false;
      if (stored) {
        if (dedupKey) this.state.ingestDedup.push({ key: dedupKey, item_type: item.type });
        accepted += 1;
      }
    }
    return { accepted };
  }

  async listProducts({ productId } = {}) {
    return this.state.products.filter((item) => !productId || item.product_id === productId).map(copy);
  }

  async listEvents(limit = 200, { productId, environment } = {}) {
    return filterOperational(this.state.events, { productId, environment }).slice(-limit).reverse().map(copy);
  }

  async listErrors(limit = 200, { productId, environment } = {}) {
    return filterOperational(this.state.errors, { productId, environment }).slice(-limit).reverse().map(copy);
  }

  async listHealth({ productId, environment, limit = 500 } = {}) {
    return filterOperational(this.state.health, { productId, environment }).slice(-limit).reverse().map(copy);
  }

  async listReleases(limit = 200, { productId, environment } = {}) {
    return filterOperational(this.state.releases, { productId, environment }).slice(-limit).reverse().map(copy);
  }

  async latestHealthByProduct({ productId } = {}) {
    const latest = {};
    const items = filterOperational(this.state.health, { productId }).sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
    for (const item of items) {
      if (!latest[item.product_id] || item.environment === "production" || latest[item.product_id].environment !== "production") {
        latest[item.product_id] = copy(item);
      }
    }
    return latest;
  }

  async appendMonitors(monitors) {
    assertOwnedBatch(this.state.monitors, monitors, (item) => item.id, "monitor");
    for (const monitor of monitors) {
      const existing = this.state.monitors.findIndex((item) => item.id === monitor.id);
      const value = { enabled: true, environment: "production", ...monitor, updated_at: new Date().toISOString() };
      if (existing >= 0) this.state.monitors[existing] = { ...this.state.monitors[existing], ...value };
      else this.state.monitors.push(value);
    }
    return { accepted: monitors.length };
  }

  async appendAlerts(alerts) {
    assertOwnedBatch(this.state.alerts, alerts, (item) => item.id, "alert");
    for (const alert of alerts) {
      const existing = this.state.alerts.findIndex((item) => item.id === alert.id);
      const value = { enabled: true, environment: "production", ...alert, updated_at: new Date().toISOString() };
      if (existing >= 0) this.state.alerts[existing] = { ...this.state.alerts[existing], ...value };
      else this.state.alerts.push(value);
    }
    return { accepted: alerts.length };
  }

  async appendStatusPages(statusPages) {
    const normalized = statusPages.map((page) => ({ public_slug: page.public_slug ?? page.product_id, components: [], ...page }));
    assertStatusPageOwnership(this.state.statusPages, normalized, this.state.products);
    for (const page of normalized) {
      const value = { ...page, updated_at: new Date().toISOString() };
      const existing = this.state.statusPages.findIndex((item) => item.public_slug === value.public_slug);
      if (existing >= 0) this.state.statusPages[existing] = { ...this.state.statusPages[existing], ...value };
      else this.state.statusPages.push(value);
    }
    return { accepted: statusPages.length };
  }

  async listMonitors({ enabledOnly = false, productId, environment } = {}) {
    return filterOperational(this.state.monitors, { productId, environment })
      .filter((monitor) => !enabledOnly || monitor.enabled !== false).map(copy);
  }

  async listAlerts({ enabledOnly = false, productId, environment } = {}) {
    return filterOperational(this.state.alerts, { productId, environment })
      .filter((alert) => !enabledOnly || alert.enabled !== false).map(copy);
  }

  async listStatusPages({ productId } = {}) {
    return this.state.statusPages.filter((item) => !productId || item.product_id === productId).map(copy);
  }

  async getProduct(productId) {
    const item = this.state.products.find((product) => product.product_id === productId);
    return item ? copy(item) : undefined;
  }

  async getStatusPage(slug) {
    const item = this.state.statusPages.find((page) => page.public_slug === slug);
    return item ? copy(item) : undefined;
  }

  async recordMonitorRun(run) {
    const monitor = this.state.monitors.find((item) => item.id === run.monitor_id);
    if (monitor && (monitor.product_id !== run.product_id || (monitor.environment ?? "production") !== (run.environment ?? "production"))) {
      throw conflictError(409, `Monitor run ownership does not match monitor ${run.monitor_id}`);
    }
    const item = {
      id: crypto.randomUUID(),
      checked_at: run.checked_at ?? new Date().toISOString(),
      environment: "production",
      severity: "medium",
      ...run
    };
    this.state.monitorRuns.push(item);
    return copy(item);
  }

  async listMonitorRuns({ productId, environment, monitorId, limit = 500 } = {}) {
    return filterOperational(this.state.monitorRuns, { productId, environment })
      .filter((item) => !monitorId || item.monitor_id === monitorId)
      .sort((a, b) => Date.parse(b.checked_at) - Date.parse(a.checked_at))
      .slice(0, limit).map(copy);
  }

  async lastMonitorRun(monitorId) {
    return (await this.listMonitorRuns({ monitorId, limit: 1 }))[0];
  }

  async appendAlertDelivery(delivery) {
    const rule = this.state.alerts.find((item) => item.id === delivery.alert_id);
    if (rule && (rule.product_id !== delivery.product_id || (rule.environment ?? "production") !== (delivery.environment ?? "production"))) {
      throw conflictError(409, `Alert delivery ownership does not match alert ${delivery.alert_id}`);
    }
    const item = { id: crypto.randomUUID(), delivered_at: new Date().toISOString(), environment: "production", ...delivery };
    this.state.alertDeliveries.push(item);
    return copy(item);
  }

  async listAlertDeliveries({ productId, environment, alertId, limit = 500 } = {}) {
    return filterOperational(this.state.alertDeliveries, { productId, environment })
      .filter((item) => !alertId || item.alert_id === alertId).slice(-limit).reverse().map(copy);
  }

  async upsertAlertInstance(input) {
    const ownershipPrefix = `${input.product_id}:${input.environment}:`;
    if (!String(input.dedup_key).startsWith(ownershipPrefix)) {
      throw conflictError(409, `Alert instance ${input.dedup_key} is outside the rule ownership scope`);
    }
    const existing = this.state.alertInstances.findIndex((item) => item.dedup_key === input.dedup_key);
    const rule = this.state.alerts.find((item) => item.id === input.rule_id);
    if (rule && (rule.product_id !== input.product_id || (rule.environment ?? "production") !== (input.environment ?? "production"))) {
      throw conflictError(409, `Alert instance ownership does not match rule ${input.rule_id}`);
    }
    if (existing >= 0) {
      const current = this.state.alertInstances[existing];
      if (current.rule_id !== input.rule_id || current.product_id !== input.product_id || current.environment !== input.environment) {
        throw conflictError(409, `Alert instance ${input.dedup_key} belongs to another rule, product, or environment`);
      }
    }
    const value = { id: existing >= 0 ? this.state.alertInstances[existing].id : crypto.randomUUID(), ...input, rule_type: input.rule_type ?? rule?.type };
    if (existing >= 0) this.state.alertInstances[existing] = value;
    else this.state.alertInstances.push(value);
    return copy(value);
  }

  async listAlertInstances({ productId, environment, status } = {}) {
    return filterOperational(this.state.alertInstances, { productId, environment })
      .filter((item) => !status || item.status === status).map(copy);
  }

  async getAlertInstance(id) {
    const item = this.state.alertInstances.find((entry) => entry.id === id);
    return item ? copy(item) : undefined;
  }

  async acknowledgeAlertInstance(id, { actor, now = new Date() } = {}) {
    const index = this.state.alertInstances.findIndex((item) => item.id === id);
    if (index < 0) return null;
    this.state.alertInstances[index] = acknowledgeAlert(this.state.alertInstances[index], { actor, now });
    return copy(this.state.alertInstances[index]);
  }

  async countEvents(productId, eventName, since, environment) {
    const sinceTime = since.getTime();
    return this.state.events.filter((item) => (
      item.product_id === productId
      && (!environment || item.environment === environment)
      && item.payload?.event === eventName
      && Date.parse(item.occurred_at) >= sinceTime
    )).length;
  }

  async recentContext(productId, limit = 20, environment) {
    const options = { productId, environment };
    return {
      product: await this.getProduct(productId),
      events: await this.listEvents(limit, options),
      errors: await this.listErrors(limit, options),
      health: await this.listHealth({ ...options, limit }),
      releases: await this.listReleases(limit, options),
      monitorRuns: await this.listMonitorRuns({ ...options, limit }),
      alertDeliveries: await this.listAlertDeliveries({ ...options, limit }),
      incidents: await this.listIncidents(options)
    };
  }

  async createIncident(incident) {
    const now = new Date().toISOString();
    const item = { id: crypto.randomUUID(), created_at: now, updated_at: now, status: "open", timeline: [], alert_ids: [], ...incident };
    this.state.incidents.push(item);
    return copy(item);
  }

  async listIncidents({ productId, environment, status } = {}) {
    return filterOperational(this.state.incidents, { productId, environment })
      .filter((item) => !status || item.status === status).map(copy);
  }

  async getIncident(id) {
    const item = this.state.incidents.find((incident) => incident.id === id);
    return item ? copy(item) : undefined;
  }

  async updateIncident(incident) {
    const index = this.state.incidents.findIndex((item) => item.id === incident.id);
    if (index < 0) return null;
    this.state.incidents[index] = copy(incident);
    return copy(incident);
  }

  async createMaintenanceWindow(input) {
    const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
    this.state.maintenanceWindows.push(item);
    return copy(item);
  }

  async listMaintenanceWindows({ productId, environment, activeAt } = {}) {
    const at = activeAt ? Date.parse(activeAt) : null;
    return filterOperational(this.state.maintenanceWindows, { productId, environment })
      .filter((item) => !Number.isFinite(at) || (Date.parse(item.starts_at) <= at && at < Date.parse(item.ends_at))).map(copy);
  }

  async runRetention(policy, now = new Date()) {
    const result = rollupAndPrune(this.state, policy, now);
    this.state = result.state;
    return { deleted: result.deleted, cutoff: result.cutoff };
  }

  async listDailyAggregates({ productId, environment } = {}) {
    return filterOperational(this.state.dailyAggregates, { productId, environment }).map(copy);
  }

  async withSchedulerLease(callback) {
    if (this.schedulerLeaseHeld) return { acquired: false, value: null };
    this.schedulerLeaseHeld = true;
    try {
      return { acquired: true, value: await callback() };
    } finally {
      this.schedulerLeaseHeld = false;
    }
  }

  async createApiKey(input) {
    const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), last_used_at: null, expires_at: null, revoked_at: null, rotated_from_id: null, ...input };
    this.state.apiKeys.push(item);
    return copy(item);
  }

  async listApiKeys(productId) {
    return this.state.apiKeys.filter((item) => item.product_id === productId).map(copy);
  }

  async getApiKey(id, productId) {
    const item = this.state.apiKeys.find((entry) => entry.id === id && (!productId || entry.product_id === productId));
    return item ? copy(item) : undefined;
  }

  async rotateApiKey(id, productId, replacement) {
    const current = this.state.apiKeys.find((item) => item.id === id && item.product_id === productId);
    if (!current || current.revoked_at) return null;
    current.revoked_at = new Date().toISOString();
    return this.createApiKey({ ...replacement, product_id: productId, rotated_from_id: current.id });
  }

  async revokeApiKey(id, productId) {
    const current = this.state.apiKeys.find((item) => item.id === id && item.product_id === productId);
    if (!current) return null;
    current.revoked_at ??= new Date().toISOString();
    return copy(current);
  }

  async findApiKey(keyHash) {
    const now = Date.now();
    const item = this.state.apiKeys.find((entry) => entry.key_hash === keyHash && !entry.revoked_at && (!entry.expires_at || Date.parse(entry.expires_at) > now));
    return item ? copy(item) : undefined;
  }

  async markApiKeyUsed(id) {
    const key = this.state.apiKeys.find((item) => item.id === id);
    if (key) key.last_used_at = new Date().toISOString();
  }

  async createComplianceScan(input) {
    const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
    this.state.complianceScans.push(item);
    return copy(item);
  }

  async listComplianceScans({ productId, limit = 100 } = {}) {
    return this.state.complianceScans.filter((item) => !productId || item.product_id === productId).slice(-limit).reverse().map(copy);
  }

  async appendAuditLog(input) {
    const item = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...input };
    this.state.auditLogs.push(item);
    return copy(item);
  }

  async listAuditLogs({ productId, limit = 200 } = {}) {
    return this.state.auditLogs.filter((item) => !productId || item.product_id === productId).slice(-limit).reverse().map(copy);
  }

  async summarize() {
    const latestHealth = await this.latestHealthByProduct();
    const statuses = [];
    for (const product of this.state.products) {
      for (const environment of productEnvironments(product)) {
        statuses.push(deriveEnvironmentStatus({
          productId: product.product_id,
          environment,
          healthChecks: this.state.health,
          configuredMonitors: this.state.monitors,
          monitorRuns: this.state.monitorRuns,
          activeAlerts: this.state.alertInstances,
          incidents: this.state.incidents
        }));
      }
    }
    return {
      products: this.state.products.length,
      events: this.state.events.length,
      errors: this.state.errors.length,
      releases: this.state.releases.length,
      monitors: this.state.monitors.length,
      alerts: this.state.alerts.length,
      active_alerts: this.state.alertInstances.filter((item) => item.status !== "resolved").length,
      failing_products: statuses.filter((item) => ["degraded", "outage"].includes(item.status)).length,
      latest_health: latestHealth,
      events_by_product: countBy(this.state.events, "product_id"),
      errors_by_product: countBy(this.state.errors, "product_id"),
      recent_events: await this.listEvents(20),
      recent_errors: await this.listErrors(20),
      status: aggregateFleetStatus(statuses)
    };
  }
}

function filterOperational(items, { productId, environment } = {}) {
  return items.filter((item) => (!productId || item.product_id === productId) && (!environment || item.environment === environment));
}

function productEnvironments(product) {
  const values = (product.environments ?? []).map((item) => typeof item === "string" ? item : item.name).filter(Boolean);
  return values.length ? [...new Set(values)] : ["production"];
}

function copy(value) {
  return structuredClone(value);
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] ?? "unknown";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}

function ingestDedupKey(item) {
  if (!item?.idempotency_key) return null;
  return `${item.product_id}\u0000${item.environment}\u0000${item.idempotency_key}`;
}

function normalizeDedupEntries(state) {
  const entries = new Map();
  for (const entry of state.ingestDedup ?? []) {
    if (typeof entry === "string") entries.set(entry, { key: entry, item_type: null });
    else if (entry?.key) entries.set(entry.key, { key: entry.key, item_type: entry.item_type ?? null });
  }
  for (const [items, itemType] of [
    [state.events, "event"],
    [state.errors, "error"],
    [state.health, "health"],
    [state.releases, "release"]
  ]) {
    for (const item of items ?? []) {
      const key = ingestDedupKey(item);
      if (key) entries.set(key, { key, item_type: itemType });
    }
  }
  return [...entries.values()];
}

function assertOwnedBatch(existingItems, incomingItems, identity, kind) {
  const seen = new Map(existingItems.map((item) => [identity(item), item]));
  for (const item of incomingItems) {
    const key = identity(item);
    const previous = seen.get(key);
    if (previous && (previous.product_id !== item.product_id || (previous.environment ?? "production") !== (item.environment ?? "production"))) {
      throw conflictError(409, `${kind} ${key} belongs to another product or environment`);
    }
    seen.set(key, item);
  }
}

function assertStatusPageOwnership(existingItems, incomingItems, products) {
  const bySlug = new Map(existingItems.map((item) => [item.public_slug, item]));
  const byProduct = new Map(existingItems.map((item) => [item.product_id, item]));
  for (const page of incomingItems) {
    const productIdOwner = products.find((product) => product.product_id === page.public_slug);
    if (productIdOwner && productIdOwner.product_id !== page.product_id) {
      throw conflictError(409, `Status slug ${page.public_slug} conflicts with another product ID`);
    }
    const slugOwner = bySlug.get(page.public_slug);
    if (slugOwner && slugOwner.product_id !== page.product_id) {
      throw conflictError(409, `Status slug ${page.public_slug} belongs to another product`);
    }
    const productPage = byProduct.get(page.product_id);
    if (productPage && productPage.public_slug !== page.public_slug) {
      throw conflictError(409, `Product ${page.product_id} already has a status page`);
    }
    bySlug.set(page.public_slug, page);
    byProduct.set(page.product_id, page);
  }
}

function conflictError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
