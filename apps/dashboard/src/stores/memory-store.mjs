import { normalizeProduct } from "../validation.mjs";
import crypto from "node:crypto";

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
    alertDeliveries: [],
    statusPages: [],
    incidents: [],
    apiKeys: []
  };
}

export class MemoryStore {
  constructor(state = createEmptyState()) {
    this.state = state;
  }

  async ready() {
    return true;
  }

  async close() {}

  async upsertProduct(input) {
    const product = normalizeProduct(input);
    const existing = this.state.products.findIndex((item) => item.product_id === product.product_id);
    if (existing >= 0) this.state.products[existing] = { ...this.state.products[existing], ...product };
    else this.state.products.push(product);
    return product;
  }

  async appendIngestItems(items) {
    let accepted = 0;
    for (const item of items) {
      if (item.type === "product") {
        await this.upsertProduct(item.payload?.contract ?? item.payload ?? item);
      } else if (item.type === "event") {
        this.state.events.push({ ...item, event_name: item.payload?.event });
      } else if (item.type === "error") {
        this.state.errors.push({ ...item, error_name: item.payload?.name, message: item.payload?.message });
      } else if (item.type === "health") {
        this.state.health.push(item);
      } else if (item.type === "release") {
        this.state.releases.push(item);
      }
      accepted += 1;
    }
    return { accepted };
  }

  async listProducts() {
    return this.state.products.slice();
  }

  async listEvents(limit = 200) {
    return this.state.events.slice(-limit).reverse();
  }

  async listErrors(limit = 200) {
    return this.state.errors.slice(-limit).reverse();
  }

  async listReleases(limit = 200) {
    return this.state.releases.slice(-limit).reverse();
  }

  async latestHealthByProduct() {
    const latest = {};
    for (const item of this.state.health) latest[item.product_id] = item;
    return latest;
  }

  async appendMonitors(monitors) {
    for (const monitor of monitors) {
      const existing = this.state.monitors.findIndex((item) => item.id === monitor.id);
      if (existing >= 0) this.state.monitors[existing] = { ...this.state.monitors[existing], ...monitor };
      else this.state.monitors.push({ enabled: true, ...monitor });
    }
    return { accepted: monitors.length };
  }

  async appendAlerts(alerts) {
    for (const alert of alerts) {
      const existing = this.state.alerts.findIndex((item) => item.id === alert.id);
      if (existing >= 0) this.state.alerts[existing] = { ...this.state.alerts[existing], ...alert };
      else this.state.alerts.push({ enabled: true, ...alert });
    }
    return { accepted: alerts.length };
  }

  async appendStatusPages(statusPages) {
    this.state.statusPages.push(...statusPages.map((page) => ({
      public_slug: page.public_slug ?? page.product_id,
      ...page
    })));
    return { accepted: statusPages.length };
  }

  async listMonitors({ enabledOnly = false } = {}) {
    return this.state.monitors.filter((monitor) => !enabledOnly || monitor.enabled !== false);
  }

  async listAlerts({ enabledOnly = false } = {}) {
    return this.state.alerts.filter((alert) => !enabledOnly || alert.enabled !== false);
  }

  async listStatusPages() {
    return this.state.statusPages.slice();
  }

  async getProduct(productId) {
    return this.state.products.find((product) => product.product_id === productId);
  }

  async getStatusPage(slug) {
    return this.state.statusPages.find((page) => page.public_slug === slug || page.product_id === slug);
  }

  async recordMonitorRun(run) {
    this.state.monitorRuns.push({ id: crypto.randomUUID?.() ?? `${Date.now()}`, checked_at: new Date().toISOString(), ...run });
    return run;
  }

  async appendAlertDelivery(delivery) {
    this.state.alertDeliveries.push({ id: crypto.randomUUID?.() ?? `${Date.now()}`, delivered_at: new Date().toISOString(), ...delivery });
    return delivery;
  }

  async countEvents(productId, eventName, since) {
    const sinceTime = since.getTime();
    return this.state.events.filter((item) =>
      item.product_id === productId &&
      item.payload?.event === eventName &&
      Date.parse(item.occurred_at) >= sinceTime
    ).length;
  }

  async recentContext(productId, limit = 20) {
    return {
      product: await this.getProduct(productId),
      events: this.state.events.filter((item) => item.product_id === productId).slice(-limit).reverse(),
      errors: this.state.errors.filter((item) => item.product_id === productId).slice(-limit).reverse(),
      health: this.state.health.filter((item) => item.product_id === productId).slice(-limit).reverse(),
      releases: this.state.releases.filter((item) => item.product_id === productId).slice(-limit).reverse(),
      monitorRuns: this.state.monitorRuns.filter((item) => item.product_id === productId).slice(-limit).reverse(),
      alertDeliveries: this.state.alertDeliveries.filter((item) => item.product_id === productId).slice(-limit).reverse()
    };
  }

  async createIncident(incident) {
    const item = { id: crypto.randomUUID?.() ?? `${Date.now()}`, created_at: new Date().toISOString(), status: "open", ...incident };
    this.state.incidents.push(item);
    return item;
  }

  async findApiKey(keyHash) {
    return this.state.apiKeys.find((item) => item.key_hash === keyHash && !item.revoked_at);
  }

  async markApiKeyUsed(id) {
    const key = this.state.apiKeys.find((item) => item.id === id);
    if (key) key.last_used_at = new Date().toISOString();
  }

  async summarize() {
    const latestHealth = await this.latestHealthByProduct();
    const failingProducts = Object.values(latestHealth).filter((item) => item.payload?.ok === false).length;
    return {
      products: this.state.products.length,
      events: this.state.events.length,
      errors: this.state.errors.length,
      releases: this.state.releases.length,
      monitors: this.state.monitors.length,
      alerts: this.state.alerts.length,
      failing_products: failingProducts,
      latest_health: latestHealth,
      events_by_product: countBy(this.state.events, "product_id"),
      errors_by_product: countBy(this.state.errors, "product_id"),
      recent_events: await this.listEvents(20),
      recent_errors: await this.listErrors(20),
      status: failingProducts ? "degraded" : "operational"
    };
  }
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] ?? "unknown";
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
}
