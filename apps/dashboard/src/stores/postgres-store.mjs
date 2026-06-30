import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProduct } from "../validation.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.resolve(__dirname, "../../db/migrations/001_initial.sql");

export class PostgresStore {
  constructor(databaseUrl, options = {}) {
    this.databaseUrl = databaseUrl;
    this.options = options;
    this.pool = null;
  }

  async ready() {
    const { Pool } = await import("pg");
    this.pool = new Pool({
      connectionString: this.databaseUrl,
      max: this.options.maxConnections ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000
    });
    await this.migrate();
    return true;
  }

  async close() {
    await this.pool?.end();
  }

  async migrate() {
    const sql = await fs.readFile(migrationPath, "utf8");
    await this.pool.query(sql);
  }

  async upsertProduct(input) {
    const product = normalizeProduct(input);
    await this.writeProduct(this.pool, product);
    return product;
  }

  async writeProduct(queryable, product) {
    await queryable.query(
      `insert into products (product_id, name, owner, standard_version, environments, critical_journeys, contract, updated_at)
       values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now())
       on conflict (product_id) do update set
         name = excluded.name,
         owner = excluded.owner,
         standard_version = excluded.standard_version,
         environments = excluded.environments,
         critical_journeys = excluded.critical_journeys,
         contract = excluded.contract,
         updated_at = now()`,
      [
        product.product_id,
        product.name,
        product.owner,
        product.standard_version,
        JSON.stringify(product.environments),
        JSON.stringify(product.critical_journeys),
        JSON.stringify(product.contract)
      ]
    );
  }

  async appendIngestItems(items) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const item of items) await this.insertTelemetry(client, item);
      await client.query("commit");
      return { accepted: items.length };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async insertTelemetry(client, item) {
    if (item.type === "product") {
      await this.writeProduct(client, normalizeProduct(item.payload?.contract ?? item.payload ?? item));
      return;
    }
    if (item.type === "event") {
      await client.query(
        `insert into telemetry_events (product_id, environment, release, event_name, anonymous_id, user_id, request_id, idempotency_key, occurred_at, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         on conflict (product_id, idempotency_key) do nothing`,
        [item.product_id, item.environment, item.release, item.payload?.event ?? "unknown", item.anonymous_id, item.user_id, item.request_id, item.idempotency_key, item.occurred_at, JSON.stringify(item.payload)]
      );
    } else if (item.type === "error") {
      await client.query(
        `insert into telemetry_errors (product_id, environment, release, error_name, message, request_id, occurred_at, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [item.product_id, item.environment, item.release, item.payload?.name ?? "Error", item.payload?.message ?? "", item.request_id, item.occurred_at, JSON.stringify(item.payload)]
      );
    } else if (item.type === "health") {
      await client.query(
        `insert into health_checks (product_id, environment, release, ok, checks, occurred_at)
         values ($1,$2,$3,$4,$5::jsonb,$6)`,
        [item.product_id, item.environment, item.release, Boolean(item.payload?.ok), JSON.stringify(item.payload?.checks ?? {}), item.occurred_at]
      );
    } else if (item.type === "release") {
      await client.query(
        `insert into releases (product_id, environment, version, properties, occurred_at)
         values ($1,$2,$3,$4::jsonb,$5)
         on conflict (product_id, environment, version) do update set properties = excluded.properties, occurred_at = excluded.occurred_at`,
        [item.product_id, item.environment, item.payload?.version ?? item.release, JSON.stringify(item.payload?.properties ?? {}), item.occurred_at]
      );
    }
  }

  async listProducts() {
    const { rows } = await this.pool.query("select product_id, name, owner, standard_version, environments, critical_journeys, updated_at from products order by name");
    return rows;
  }

  async listEvents(limit = 200) {
    const { rows } = await this.pool.query(
      `select product_id, environment, release, occurred_at, payload from telemetry_events order by occurred_at desc limit $1`,
      [limit]
    );
    return rows;
  }

  async listErrors(limit = 200) {
    const { rows } = await this.pool.query(
      `select product_id, environment, release, occurred_at, payload from telemetry_errors order by occurred_at desc limit $1`,
      [limit]
    );
    return rows;
  }

  async latestHealthByProduct() {
    const { rows } = await this.pool.query(
      `select distinct on (product_id) product_id, environment, release, occurred_at, jsonb_build_object('ok', ok, 'checks', checks) as payload
       from health_checks order by product_id, occurred_at desc`
    );
    return Object.fromEntries(rows.map((row) => [row.product_id, row]));
  }

  async appendMonitors(monitors) {
    for (const monitor of monitors) {
      await this.pool.query(
        `insert into monitors (id, product_id, type, name, config, severity, enabled, updated_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,true,now())
         on conflict (id) do update set name=excluded.name, config=excluded.config, severity=excluded.severity, enabled=true, updated_at=now()`,
        [monitor.id, monitor.product_id ?? productIdFromId(monitor.id), monitor.type, monitor.name, JSON.stringify(monitor), monitor.severity ?? "medium"]
      );
    }
    return { accepted: monitors.length };
  }

  async appendAlerts(alerts) {
    for (const alert of alerts) {
      await this.pool.query(
        `insert into alerts (id, product_id, name, condition, severity, notify, action, enabled, updated_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,true,now())
         on conflict (id) do update set name=excluded.name, condition=excluded.condition, severity=excluded.severity, notify=excluded.notify, action=excluded.action, enabled=true, updated_at=now()`,
        [alert.id, alert.product_id ?? productIdFromId(alert.id), alert.name, alert.condition, alert.severity ?? "medium", JSON.stringify(alert.notify ?? []), alert.action ?? ""]
      );
    }
    return { accepted: alerts.length };
  }

  async appendStatusPages(statusPages) {
    for (const page of statusPages) {
      await this.pool.query(
        `insert into status_pages (product_id, title, body, public_slug, generated_at, updated_at)
         values ($1,$2,$3,$4,$5,now())
         on conflict (public_slug) do update set title=excluded.title, body=excluded.body, generated_at=excluded.generated_at, updated_at=now()`,
        [page.product_id, page.title, page.body, page.public_slug ?? page.product_id, page.generated_at ?? new Date().toISOString()]
      );
    }
    return { accepted: statusPages.length };
  }

  async listMonitors({ enabledOnly = false } = {}) {
    const { rows } = await this.pool.query(`select id, product_id, type, name, config, severity, enabled from monitors ${enabledOnly ? "where enabled = true" : ""} order by name`);
    return rows.map((row) => ({ ...row.config, id: row.id, product_id: row.product_id, type: row.type, name: row.name, severity: row.severity, enabled: row.enabled }));
  }

  async listAlerts({ enabledOnly = false } = {}) {
    const { rows } = await this.pool.query(`select id, product_id, name, condition, severity, notify, action, enabled from alerts ${enabledOnly ? "where enabled = true" : ""} order by name`);
    return rows;
  }

  async recordMonitorRun(run) {
    await this.pool.query(
      `insert into monitor_runs (monitor_id, product_id, ok, status, latency_ms, details) values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [run.monitor_id, run.product_id, run.ok, run.status, run.latency_ms ?? null, JSON.stringify(run.details ?? {})]
    );
  }

  async appendAlertDelivery(delivery) {
    await this.pool.query(
      `insert into alert_deliveries (alert_id, product_id, channel, status, message, response) values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [delivery.alert_id, delivery.product_id, delivery.channel, delivery.status, delivery.message, JSON.stringify(delivery.response ?? {})]
    );
  }

  async countEvents(productId, eventName, since) {
    const { rows } = await this.pool.query(
      `select count(*)::int as count from telemetry_events where product_id = $1 and event_name = $2 and occurred_at >= $3`,
      [productId, eventName, since]
    );
    return rows[0].count;
  }

  async recentContext(productId, limit = 20) {
    const product = await this.getProduct(productId);
    const events = await this.pool.query(`select * from telemetry_events where product_id=$1 order by occurred_at desc limit $2`, [productId, limit]);
    const errors = await this.pool.query(`select * from telemetry_errors where product_id=$1 order by occurred_at desc limit $2`, [productId, limit]);
    const health = await this.pool.query(`select * from health_checks where product_id=$1 order by occurred_at desc limit $2`, [productId, limit]);
    const releases = await this.pool.query(`select * from releases where product_id=$1 order by occurred_at desc limit $2`, [productId, limit]);
    const monitorRuns = await this.pool.query(`select * from monitor_runs where product_id=$1 order by checked_at desc limit $2`, [productId, limit]);
    const alertDeliveries = await this.pool.query(`select * from alert_deliveries where product_id=$1 order by delivered_at desc limit $2`, [productId, limit]);
    return { product, events: events.rows, errors: errors.rows, health: health.rows, releases: releases.rows, monitorRuns: monitorRuns.rows, alertDeliveries: alertDeliveries.rows };
  }

  async getProduct(productId) {
    const { rows } = await this.pool.query("select * from products where product_id=$1", [productId]);
    return rows[0];
  }

  async getStatusPage(slug) {
    const { rows } = await this.pool.query("select * from status_pages where public_slug=$1 or product_id=$1 order by updated_at desc limit 1", [slug]);
    return rows[0];
  }

  async createIncident(incident) {
    const { rows } = await this.pool.query(
      `insert into incidents (product_id, title, severity, status, package_markdown) values ($1,$2,$3,$4,$5) returning *`,
      [incident.product_id, incident.title, incident.severity ?? "medium", incident.status ?? "open", incident.package_markdown]
    );
    return rows[0];
  }

  async findApiKey(keyHash) {
    const { rows } = await this.pool.query("select * from api_keys where key_hash=$1 and revoked_at is null and (expires_at is null or expires_at > now())", [keyHash]);
    return rows[0];
  }

  async markApiKeyUsed(id) {
    await this.pool.query("update api_keys set last_used_at = now() where id=$1", [id]);
  }

  async summarize() {
    const products = await this.listProducts();
    const latestHealth = await this.latestHealthByProduct();
    const events = await this.listEvents(20);
    const errors = await this.listErrors(20);
    const counts = await this.pool.query(`
      select
        (select count(*)::int from telemetry_events) as events,
        (select count(*)::int from telemetry_errors) as errors,
        (select count(*)::int from releases) as releases,
        (select count(*)::int from monitors) as monitors,
        (select count(*)::int from alerts) as alerts
    `);
    const failingProducts = Object.values(latestHealth).filter((item) => item.payload?.ok === false).length;
    return {
      products: products.length,
      ...counts.rows[0],
      failing_products: failingProducts,
      latest_health: latestHealth,
      events_by_product: await this.countByTable("telemetry_events"),
      errors_by_product: await this.countByTable("telemetry_errors"),
      recent_events: events,
      recent_errors: errors,
      status: failingProducts ? "degraded" : "operational"
    };
  }

  async countByTable(table) {
    const { rows } = await this.pool.query(`select product_id, count(*)::int as count from ${table} group by product_id`);
    return Object.fromEntries(rows.map((row) => [row.product_id, row.count]));
  }
}

function productIdFromId(id) {
  return String(id).replace(/-(healthz|readyz|dashboard-ingest|health-down|error-spike|journey-drop|.+-journey)$/, "");
}
