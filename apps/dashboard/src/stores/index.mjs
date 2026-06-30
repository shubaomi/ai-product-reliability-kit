import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "./json-store.mjs";
import { MemoryStore } from "./memory-store.mjs";
import { PostgresStore } from "./postgres-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultStorePath = path.resolve(__dirname, "../../data/store.json");

export async function createStore(config, options = {}) {
  if (options.store) return options.store;
  if (options.memory) {
    const store = new MemoryStore();
    await store.ready();
    return store;
  }
  if (config.storeMode === "postgres") {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is required when APR_STORE_MODE=postgres");
    const store = new PostgresStore(config.databaseUrl);
    await store.ready();
    return store;
  }
  const store = new JsonStore(options.storePath ?? config.dashboardStore ?? defaultStorePath);
  await store.ready();
  return store;
}

