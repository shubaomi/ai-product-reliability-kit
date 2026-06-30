import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = await fs.readFile(path.resolve(__dirname, "../db/migrations/001_initial.sql"), "utf8");

for (const table of [
  "organizations",
  "users",
  "api_keys",
  "products",
  "telemetry_events",
  "telemetry_errors",
  "health_checks",
  "releases",
  "monitors",
  "monitor_runs",
  "alerts",
  "alert_deliveries",
  "status_pages",
  "incidents"
]) {
  assert.match(sql, new RegExp(`create table if not exists ${table}`));
}

for (const index of [
  "telemetry_events_product_time_idx",
  "telemetry_events_product_name_time_idx",
  "telemetry_errors_product_time_idx",
  "health_checks_product_time_idx",
  "monitor_runs_monitor_time_idx",
  "api_keys_hash_active_idx"
]) {
  assert.match(sql, new RegExp(`create index if not exists ${index}`));
}

assert.match(sql, /references products\(product_id\) on delete cascade/);

console.log("Postgres schema tests OK");
