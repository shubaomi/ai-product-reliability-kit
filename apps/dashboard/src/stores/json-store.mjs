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
    const temporary = `${this.storePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(temporary, this.storePath);
  }

  async mutate(method, args) {
    const result = await MemoryStore.prototype[method].apply(this, args);
    if (result !== null) await this.persist();
    return result;
  }

  async upsertProduct(...args) { return this.mutate("upsertProduct", args); }
  async appendIngestItems(...args) { return this.mutate("appendIngestItems", args); }
  async appendMonitors(...args) { return this.mutate("appendMonitors", args); }
  async appendAlerts(...args) { return this.mutate("appendAlerts", args); }
  async appendStatusPages(...args) { return this.mutate("appendStatusPages", args); }
  async recordMonitorRun(...args) { return this.mutate("recordMonitorRun", args); }
  async appendAlertDelivery(...args) { return this.mutate("appendAlertDelivery", args); }
  async upsertAlertInstance(...args) { return this.mutate("upsertAlertInstance", args); }
  async acknowledgeAlertInstance(...args) { return this.mutate("acknowledgeAlertInstance", args); }
  async createIncident(...args) { return this.mutate("createIncident", args); }
  async updateIncident(...args) { return this.mutate("updateIncident", args); }
  async createMaintenanceWindow(...args) { return this.mutate("createMaintenanceWindow", args); }
  async runRetention(...args) { return this.mutate("runRetention", args); }
  async createApiKey(...args) { return this.mutate("createApiKey", args); }
  async rotateApiKey(...args) { return this.mutate("rotateApiKey", args); }
  async revokeApiKey(...args) { return this.mutate("revokeApiKey", args); }
  async markApiKeyUsed(...args) { return this.mutate("markApiKeyUsed", args); }
  async createComplianceScan(...args) { return this.mutate("createComplianceScan", args); }
  async appendAuditLog(...args) { return this.mutate("appendAuditLog", args); }
}
