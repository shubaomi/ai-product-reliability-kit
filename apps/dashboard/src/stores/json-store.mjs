import { promises as fs } from "node:fs";
import path from "node:path";
import { MemoryStore, createEmptyState } from "./memory-store.mjs";

export class JsonStore extends MemoryStore {
  constructor(storePath) {
    super(createEmptyState());
    this.storePath = storePath;
  }

  async ready() {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    try {
      this.state = { ...createEmptyState(), ...JSON.parse(await fs.readFile(this.storePath, "utf8")) };
    } catch {
      await this.persist();
    }
    return true;
  }

  async persist() {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    await fs.writeFile(this.storePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  async upsertProduct(input) {
    const result = await super.upsertProduct(input);
    await this.persist();
    return result;
  }

  async appendIngestItems(items) {
    const result = await super.appendIngestItems(items);
    await this.persist();
    return result;
  }

  async appendMonitors(monitors) {
    const result = await super.appendMonitors(monitors);
    await this.persist();
    return result;
  }

  async appendAlerts(alerts) {
    const result = await super.appendAlerts(alerts);
    await this.persist();
    return result;
  }

  async appendStatusPages(statusPages) {
    const result = await super.appendStatusPages(statusPages);
    await this.persist();
    return result;
  }

  async recordMonitorRun(run) {
    const result = await super.recordMonitorRun(run);
    await this.persist();
    return result;
  }

  async appendAlertDelivery(delivery) {
    const result = await super.appendAlertDelivery(delivery);
    await this.persist();
    return result;
  }

  async createIncident(incident) {
    const result = await super.createIncident(incident);
    await this.persist();
    return result;
  }
}

