#!/usr/bin/env node
import { loadConfig, validateConfig } from "../src/config.mjs";
import { PostgresStore } from "../src/stores/postgres-store.mjs";

const config = loadConfig();
validateConfig(config);

if (config.storeMode !== "postgres" && !config.databaseUrl) {
  throw new Error("Set DATABASE_URL or APR_STORE_MODE=postgres before running migrations.");
}

const store = new PostgresStore(config.databaseUrl);
await store.ready();
await store.close();

process.stdout.write("Dashboard Postgres migrations applied.\n");
