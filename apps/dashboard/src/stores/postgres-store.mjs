import { httpError, normalizeProduct } from "../validation.mjs";
import { aggregateFleetStatus, deriveEnvironmentStatus } from "../status-model.mjs";
import { migrationReadiness, runMigrations } from "./migrations.mjs";

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
    try {
      await this.migrate();
      return true;
    } catch (error) {
      await this.pool.end();
      this.pool = null;
      throw error;
    }
  }

  async readiness() {
    try {
      const ping = await this.pool.query("select 1 as ok");
      const migrations = await migrationReadiness(this.pool, { migrationsDir: this.options.migrationsDir });
      const storeReady = ping.rows[0]?.ok === 1;
      return {
        ok: storeReady && migrations.ready,
        checks: { store: storeReady, migrations: migrations.ready },
        migration: migrations
      };
    } catch {
      return { ok: false, checks: { store: false, migrations: false } };
    }
  }

  async close() {
    await this.pool?.end();
  }

  async migrate() {
    return runMigrations(this.pool, { migrationsDir: this.options.migrationsDir });
  }

  async upsertProduct(input) {
    const product = normalizeProduct(input);
    await this.writeProduct(this.pool, product);
    return product;
  }

  async writeProduct(queryable, product) {
    try {
      await queryable.query(
        `insert into products (product_id, name, owner, standard_version, environments, critical_journeys, contract, public_status_enabled, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())
         on conflict (product_id) do update set
           name = excluded.name,
           owner = excluded.owner,
           standard_version = excluded.standard_version,
           environments = excluded.environments,
           critical_journeys = excluded.critical_journeys,
           contract = excluded.contract,
           public_status_enabled = excluded.public_status_enabled,
           updated_at = now()`,
        [
          product.product_id,
          product.name,
          product.owner,
          product.standard_version,
          JSON.stringify(product.environments),
          JSON.stringify(product.critical_journeys),
          JSON.stringify(product.contract),
          product.public_status_enabled ?? product.contract?.public_status?.enabled === true
        ]
      );
    } catch (error) {
      if (error.code === "23514" && /public status slug/i.test(error.message)) {
        throw httpError(409, `Product ${product.product_id} conflicts with another product's public status slug`);
      }
      throw error;
    }
  }

  async appendIngestItems(items) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      let accepted = 0;
      for (const item of items) {
        if (await this.insertTelemetry(client, item)) accepted += 1;
      }
      await client.query("commit");
      return { accepted };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async insertTelemetry(client, item) {
    if (item.idempotency_key) {
      const claim = await client.query(
        `insert into ingest_dedup (product_id, environment, idempotency_key, item_type)
         values ($1,$2,$3,$4) on conflict do nothing returning idempotency_key`,
        [item.product_id, item.environment, item.idempotency_key, item.type]
      );
      if (!claim.rowCount) {
        const existing = await client.query(
          `select item_type from ingest_dedup
           where product_id=$1 and environment=$2 and idempotency_key=$3`,
          [item.product_id, item.environment, item.idempotency_key]
        );
        if (existing.rows[0]?.item_type && existing.rows[0].item_type !== item.type) {
          throw httpError(409, `Idempotency key is already used for telemetry type ${existing.rows[0].item_type}`);
        }
        return false;
      }
    }
    if (item.type === "product") {
      const product = normalizeProduct(item.payload?.contract ?? item.payload ?? item);
      if (product.product_id !== item.product_id) throw httpError(400, "Product envelope product_id must match payload contract product.id");
      await this.writeProduct(client, product);
      return true;
    }
    if (item.type === "event") {
      const inserted = await client.query(
        `insert into telemetry_events (product_id, environment, release, event_name, anonymous_id, user_id, request_id, idempotency_key, original_idempotency_key, occurred_at, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10::jsonb)
         on conflict (product_id, idempotency_key) do nothing`,
        [item.product_id, item.environment, item.release, item.payload?.event ?? "unknown", item.anonymous_id, item.user_id, item.request_id, item.idempotency_key, item.occurred_at, JSON.stringify(item.payload)]
      );
      if (!inserted.rowCount && item.idempotency_key) throw new Error("Ingest dedup ledger and telemetry event uniqueness disagree");
    } else if (item.type === "error") {
      await client.query(
        `insert into telemetry_errors (product_id, environment, release, error_name, message, request_id, idempotency_key, occurred_at, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [item.product_id, item.environment, item.release, item.payload?.name ?? "Error", item.payload?.message ?? "", item.request_id, item.idempotency_key, item.occurred_at, JSON.stringify(item.payload)]
      );
    } else if (item.type === "health") {
      await client.query(
        `insert into health_checks (product_id, environment, release, ok, checks, idempotency_key, occurred_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [item.product_id, item.environment, item.release, Boolean(item.payload?.ok), JSON.stringify(item.payload?.checks ?? {}), item.idempotency_key, item.occurred_at]
      );
    } else if (item.type === "release") {
      await client.query(
        `insert into releases (product_id, environment, version, properties, occurred_at)
         values ($1,$2,$3,$4::jsonb,$5)
         on conflict (product_id, environment, version) do update set properties = excluded.properties, occurred_at = excluded.occurred_at`,
        [item.product_id, item.environment, item.payload?.version ?? item.release, JSON.stringify(item.payload?.properties ?? {}), item.occurred_at]
      );
    } else throw httpError(400, `Unsupported telemetry type: ${item.type}`);
    return true;
  }

  async listProducts({ productId } = {}) {
    const { rows } = await this.pool.query(
      `select product_id, name, owner, standard_version, environments, critical_journeys, contract, public_status_enabled, created_at, updated_at
       from products ${productId ? "where product_id=$1" : ""} order by name`,
      productId ? [productId] : []
    );
    return rows;
  }

  async listEvents(limit = 200, { productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment }, 2);
    const { rows } = await this.pool.query(
      `select product_id, environment, release, anonymous_id, user_id, request_id,
              coalesce(original_idempotency_key, idempotency_key) as idempotency_key, occurred_at, payload
       from telemetry_events ${filter.clause} order by occurred_at desc limit $1`,
      [limit, ...filter.params]
    );
    return rows;
  }

  async listErrors(limit = 200, { productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment }, 2);
    const { rows } = await this.pool.query(
      `select product_id, environment, release, request_id, idempotency_key, occurred_at, payload
       from telemetry_errors ${filter.clause} order by occurred_at desc limit $1`,
      [limit, ...filter.params]
    );
    return rows;
  }

  async listHealth({ productId, environment, limit = 500 } = {}) {
    const filter = operationalFilter({ productId, environment }, 2);
    const { rows } = await this.pool.query(
      `select product_id, environment, release, idempotency_key, occurred_at, jsonb_build_object('ok', ok, 'checks', checks) as payload
       from health_checks ${filter.clause} order by occurred_at desc limit $1`,
      [limit, ...filter.params]
    );
    return rows;
  }

  async listReleases(limit = 200, { productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment }, 2);
    const { rows } = await this.pool.query(
      `select product_id, environment, version, occurred_at, properties as payload
       from releases ${filter.clause} order by occurred_at desc limit $1`,
      [limit, ...filter.params]
    );
    return rows;
  }

  async latestHealthByProduct({ productId } = {}) {
    const { rows } = await this.pool.query(
      `select distinct on (product_id) product_id, environment, release, occurred_at, jsonb_build_object('ok', ok, 'checks', checks) as payload
       from health_checks ${productId ? "where product_id=$1" : ""}
       order by product_id, (environment = 'production') desc, occurred_at desc`,
      productId ? [productId] : []
    );
    return Object.fromEntries(rows.map((row) => [row.product_id, row]));
  }

  async appendMonitors(monitors) {
    return this.writeOwnedBatch(monitors, async (client, monitor) => {
      const result = await client.query(
        `insert into monitors (id, product_id, environment, type, name, config, severity, enabled, updated_at)
         values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,now())
         on conflict (id) do update set type=excluded.type, name=excluded.name, config=excluded.config,
           severity=excluded.severity, enabled=excluded.enabled, updated_at=now()
         where monitors.product_id=excluded.product_id and monitors.environment=excluded.environment
         returning id`,
        [monitor.id, monitor.product_id ?? productIdFromId(monitor.id), monitor.environment ?? "production", monitor.type, monitor.name, JSON.stringify(monitor), monitor.severity ?? "medium", monitor.enabled !== false]
      );
      if (!result.rowCount) throw httpError(409, `Monitor ${monitor.id} belongs to another product or environment`);
    });
  }

  async appendAlerts(alerts) {
    return this.writeOwnedBatch(alerts, async (client, alert) => {
      const result = await client.query(
        `insert into alerts (id, product_id, environment, type, name, condition, config, severity, notify, action, enabled, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,now())
         on conflict (id) do update set type=excluded.type, name=excluded.name, condition=excluded.condition,
           config=excluded.config, severity=excluded.severity, notify=excluded.notify, action=excluded.action,
           enabled=excluded.enabled, updated_at=now()
         where alerts.product_id=excluded.product_id and alerts.environment=excluded.environment
         returning id`,
        [alert.id, alert.product_id ?? productIdFromId(alert.id), alert.environment ?? "production", alert.type, alert.name, alert.condition ?? null, JSON.stringify(alert), alert.severity ?? "medium", JSON.stringify(alert.notify ?? []), alert.action ?? "", alert.enabled !== false]
      );
      if (!result.rowCount) throw httpError(409, `Alert ${alert.id} belongs to another product or environment`);
    });
  }

  async appendStatusPages(statusPages) {
    return this.writeOwnedBatch(statusPages, async (client, page) => {
      try {
        const result = await client.query(
          `insert into status_pages (product_id, title, body, public_slug, public_summary, components, generated_at, updated_at)
           values ($1,$2,$3,$4,$5,$6::jsonb,$7,now())
           on conflict (public_slug) do update set title=excluded.title, body=excluded.body,
             public_summary=excluded.public_summary, components=excluded.components,
             generated_at=excluded.generated_at, updated_at=now()
           where status_pages.product_id=excluded.product_id
           returning id`,
          [page.product_id, page.title, page.body ?? "", page.public_slug ?? page.product_id, page.public_summary ?? null, JSON.stringify(page.components ?? []), page.generated_at ?? new Date().toISOString()]
        );
        if (!result.rowCount) throw httpError(409, `Status slug ${page.public_slug ?? page.product_id} belongs to another product`);
      } catch (error) {
        if (error.status === 409) throw error;
        if (error.code === "23505") throw httpError(409, `Product ${page.product_id} already has a status page`);
        if (error.code === "23514" && /public slug/i.test(error.message)) throw httpError(409, `Status slug ${page.public_slug ?? page.product_id} conflicts with another product ID`);
        throw error;
      }
    });
  }

  async writeOwnedBatch(items, writeItem) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      for (const item of items) await writeItem(client, item);
      await client.query("commit");
      return { accepted: items.length };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listMonitors({ enabledOnly = false, productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment }, 1, enabledOnly ? ["enabled = true"] : []);
    const { rows } = await this.pool.query(`select id, product_id, environment, type, name, config, severity, enabled from monitors ${filter.clause} order by name`, filter.params);
    return rows.map((row) => ({ ...row.config, id: row.id, product_id: row.product_id, environment: row.environment, type: row.type, name: row.name, severity: row.severity, enabled: row.enabled }));
  }

  async listAlerts({ enabledOnly = false, productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment }, 1, enabledOnly ? ["enabled = true"] : []);
    const { rows } = await this.pool.query(`select id, product_id, environment, type, name, condition, config, severity, notify, action, enabled from alerts ${filter.clause} order by name`, filter.params);
    return rows.map((row) => ({ ...row.config, id: row.id, product_id: row.product_id, environment: row.environment, type: row.type, name: row.name, condition: row.condition, severity: row.severity, notify: row.notify, action: row.action, enabled: row.enabled }));
  }

  async listStatusPages({ productId } = {}) {
    const { rows } = await this.pool.query(
      `select * from status_pages ${productId ? "where product_id=$1" : ""} order by updated_at desc`,
      productId ? [productId] : []
    );
    return rows;
  }

  async recordMonitorRun(run) {
    const { rows } = await this.pool.query(
      `insert into monitor_runs (monitor_id, product_id, environment, severity, failure_threshold, interval_seconds, ok, status, latency_ms, details, checked_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11) returning *`,
      [run.monitor_id, run.product_id, run.environment ?? "production", run.severity ?? "medium", run.failure_threshold ?? 2, run.interval_seconds ?? 60, run.ok, run.status, run.latency_ms ?? null, JSON.stringify(run.details ?? {}), run.checked_at ?? new Date().toISOString()]
    );
    return rows[0];
  }

  async listMonitorRuns({ productId, environment, monitorId, limit = 500 } = {}) {
    const filter = operationalFilter({ productId, environment }, 2, monitorId ? [`monitor_id=$${2 + [productId, environment].filter(Boolean).length}`] : []);
    const params = [limit, ...filter.params, ...(monitorId ? [monitorId] : [])];
    const { rows } = await this.pool.query(
      `select * from monitor_runs ${filter.clause} order by checked_at desc limit $1`,
      params
    );
    return rows;
  }

  async lastMonitorRun(monitorId) {
    return (await this.listMonitorRuns({ monitorId, limit: 1 }))[0];
  }

  async appendAlertDelivery(delivery) {
    await this.pool.query(
      `insert into alert_deliveries (alert_id, product_id, environment, dedup_key, notification_type, channel, status, message, response, delivered_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
      [delivery.alert_id, delivery.product_id, delivery.environment ?? "production", delivery.dedup_key ?? null, delivery.notification_type ?? "alert", delivery.channel, delivery.status, delivery.message, JSON.stringify(delivery.response ?? {}), delivery.delivered_at ?? new Date().toISOString()]
    );
  }

  async countEvents(productId, eventName, since, environment) {
    const { rows } = await this.pool.query(
      `select count(*)::int as count from telemetry_events
       where product_id = $1 and event_name = $2 and occurred_at >= $3 and ($4::text is null or environment=$4)`,
      [productId, eventName, since, environment ?? null]
    );
    return rows[0].count;
  }

  async recentContext(productId, limit = 20, environment) {
    const product = await this.getProduct(productId);
    const options = { productId, environment };
    const [events, errors, health, releases, monitorRuns, alertDeliveries, incidents] = await Promise.all([
      this.listEvents(limit, options), this.listErrors(limit, options), this.listHealth({ ...options, limit }),
      this.listReleases(limit, options), this.listMonitorRuns({ ...options, limit }),
      this.listAlertDeliveries({ ...options, limit }), this.listIncidents(options)
    ]);
    return { product, events, errors, health, releases, monitorRuns, alertDeliveries, incidents };
  }

  async getProduct(productId) {
    const { rows } = await this.pool.query("select * from products where product_id=$1", [productId]);
    return rows[0];
  }

  async getStatusPage(slug) {
    const { rows } = await this.pool.query("select * from status_pages where public_slug=$1 limit 1", [slug]);
    return rows[0];
  }

  async createIncident(incident) {
    const { rows } = await this.pool.query(
      `insert into incidents
       (id, product_id, environment, title, severity, status, owner, alert_ids, recovery_note, timeline, package_markdown, opened_at, acknowledged_at, acknowledged_by, resolved_at, created_at, updated_at)
       values (coalesce($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,$14,$15,coalesce($16,now()),coalesce($17,now())) returning *`,
      [incident.id ?? null, incident.product_id, incident.environment ?? "production", incident.title, incident.severity ?? "medium", incident.status ?? "open", incident.owner ?? null, JSON.stringify(incident.alert_ids ?? []), incident.recovery_note ?? null, JSON.stringify(incident.timeline ?? []), incident.package_markdown ?? "", incident.opened_at ?? incident.created_at ?? new Date().toISOString(), incident.acknowledged_at ?? null, incident.acknowledged_by ?? null, incident.resolved_at ?? null, incident.created_at ?? null, incident.updated_at ?? null]
    );
    return rows[0];
  }

  async listIncidents({ productId, environment, status } = {}) {
    const filter = operationalFilter({ productId, environment }, 1, status ? [`status=$${1 + [productId, environment].filter(Boolean).length}`] : []);
    const { rows } = await this.pool.query(
      `select * from incidents ${filter.clause} order by updated_at desc`,
      [...filter.params, ...(status ? [status] : [])]
    );
    return rows;
  }

  async getIncident(id) {
    const { rows } = await this.pool.query("select * from incidents where id=$1", [id]);
    return rows[0];
  }

  async updateIncident(incident) {
    const { rows } = await this.pool.query(
      `update incidents set status=$2, owner=$3, alert_ids=$4::jsonb, recovery_note=$5, timeline=$6::jsonb,
       opened_at=$7, acknowledged_at=$8, acknowledged_by=$9, resolved_at=$10, updated_at=$11
       where id=$1 returning *`,
      [incident.id, incident.status, incident.owner ?? null, JSON.stringify(incident.alert_ids ?? []), incident.recovery_note ?? null, JSON.stringify(incident.timeline ?? []), incident.opened_at, incident.acknowledged_at ?? null, incident.acknowledged_by ?? null, incident.resolved_at ?? null, incident.updated_at ?? new Date().toISOString()]
    );
    return rows[0];
  }

  async upsertAlertInstance(input) {
    let result;
    try {
      result = await this.pool.query(
      `insert into alert_instances
       (rule_id, rule_type, product_id, environment, dedup_key, name, severity, status, reason, evidence, opened_at,
        acknowledged_at, acknowledged_by, resolved_at, last_seen_at, last_notified_at, recovery_count,
        recovery_notified_at, occurrence_count, updated_at)
       values ($1,coalesce($2::text,(select type from alerts where id=$1)),$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       on conflict (dedup_key) do update set status=excluded.status, reason=excluded.reason, evidence=excluded.evidence,
        acknowledged_at=excluded.acknowledged_at, acknowledged_by=excluded.acknowledged_by,
        resolved_at=excluded.resolved_at, last_seen_at=excluded.last_seen_at,
        last_notified_at=excluded.last_notified_at, recovery_count=excluded.recovery_count,
        recovery_notified_at=excluded.recovery_notified_at, occurrence_count=excluded.occurrence_count,
        rule_type=excluded.rule_type, severity=excluded.severity, name=excluded.name, updated_at=now()
       where alert_instances.rule_id=excluded.rule_id
         and alert_instances.product_id=excluded.product_id
         and alert_instances.environment=excluded.environment
       returning *`,
      [input.rule_id, input.rule_type ?? null, input.product_id, input.environment, input.dedup_key, input.name ?? input.rule_id, input.severity ?? "medium", input.status, input.reason ?? null, JSON.stringify(input.evidence ?? {}), input.opened_at, input.acknowledged_at ?? null, input.acknowledged_by ?? null, input.resolved_at ?? null, input.last_seen_at, input.last_notified_at ?? null, input.recovery_count ?? 0, input.recovery_notified_at ?? null, input.occurrence_count ?? 1]
      );
    } catch (error) {
      if (error.code === "23514" && /alert instance/i.test(error.message)) {
        throw httpError(409, `Alert instance ${input.dedup_key} is outside the rule ownership scope`);
      }
      throw error;
    }
    if (!result.rowCount) throw httpError(409, `Alert instance ${input.dedup_key} belongs to another rule, product, or environment`);
    return result.rows[0];
  }

  async listAlertInstances({ productId, environment, status } = {}) {
    const extras = status ? [`status=$${1 + [productId, environment].filter(Boolean).length}`] : [];
    const filter = operationalFilter({ productId, environment }, 1, extras);
    const { rows } = await this.pool.query(
      `select * from alert_instances ${filter.clause} order by updated_at desc`,
      [...filter.params, ...(status ? [status] : [])]
    );
    return rows;
  }

  async getAlertInstance(id) {
    const { rows } = await this.pool.query("select * from alert_instances where id=$1", [id]);
    return rows[0];
  }

  async acknowledgeAlertInstance(id, { actor, now = new Date() } = {}) {
    const { rows } = await this.pool.query(
      `update alert_instances set status='acknowledged', acknowledged_by=$2, acknowledged_at=$3, updated_at=now()
       where id=$1 and status in ('open','acknowledged') returning *`,
      [id, actor ?? "unknown", now]
    );
    return rows[0];
  }

  async listAlertDeliveries({ productId, environment, alertId, limit = 500 } = {}) {
    const baseCount = [productId, environment].filter(Boolean).length;
    const filter = operationalFilter({ productId, environment }, 2, alertId ? [`alert_id=$${2 + baseCount}`] : []);
    const { rows } = await this.pool.query(
      `select * from alert_deliveries ${filter.clause} order by delivered_at desc limit $1`,
      [limit, ...filter.params, ...(alertId ? [alertId] : [])]
    );
    return rows;
  }

  async createMaintenanceWindow(input) {
    const { rows } = await this.pool.query(
      `insert into maintenance_windows (product_id, environment, name, starts_at, ends_at)
       values ($1,$2,$3,$4,$5) returning *`,
      [input.product_id, input.environment, input.name, input.starts_at, input.ends_at]
    );
    return rows[0];
  }

  async listMaintenanceWindows({ productId, environment, activeAt } = {}) {
    const baseCount = [productId, environment].filter(Boolean).length;
    const filter = operationalFilter(
      { productId, environment },
      1,
      activeAt ? [`starts_at <= $${1 + baseCount}`, `ends_at > $${2 + baseCount}`] : []
    );
    const { rows } = await this.pool.query(
      `select * from maintenance_windows ${filter.clause} order by starts_at desc`,
      [...filter.params, ...(activeAt ? [activeAt, activeAt] : [])]
    );
    return rows;
  }

  async listDailyAggregates({ productId, environment } = {}) {
    const filter = operationalFilter({ productId, environment });
    const { rows } = await this.pool.query(
      `select * from daily_aggregates ${filter.clause} order by bucket_date desc`,
      filter.params
    );
    return rows;
  }

  async withSchedulerLease(callback) {
    const client = await this.pool.connect();
    const lockId = 1_747_790_031;
    try {
      const { rows } = await client.query("select pg_try_advisory_lock($1) as acquired", [lockId]);
      if (!rows[0]?.acquired) return { acquired: false, value: null };
      try {
        return { acquired: true, value: await callback() };
      } finally {
        await client.query("select pg_advisory_unlock($1)", [lockId]);
      }
    } finally {
      client.release();
    }
  }

  async runRetention({ rawRetentionDays }, now = new Date()) {
    const days = Number(rawRetentionDays);
    if (!Number.isFinite(days) || days <= 0) throw new Error("rawRetentionDays must be positive");
    const cutoff = new Date(now.getTime() - days * 86_400_000);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("select pg_advisory_xact_lock($1)", [1_747_790_032]);
      await rollupPostgres(client, cutoff);
      const deleted = {};
      for (const [name, table, timestamp] of RETENTION_TABLES) {
        const result = await client.query(`delete from ${table} where ${timestamp} < $1`, [cutoff]);
        deleted[name] = result.rowCount;
      }
      await client.query("commit");
      return { deleted, cutoff: cutoff.toISOString() };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createApiKey(input) {
    const { rows } = await this.pool.query(
      `insert into api_keys (product_id, name, key_hash, scopes, expires_at, rotated_from_id)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [input.product_id, input.name, input.key_hash, input.scopes, input.expires_at ?? null, input.rotated_from_id ?? null]
    );
    return rows[0];
  }

  async listApiKeys(productId) {
    const { rows } = await this.pool.query(
      `select * from api_keys where product_id=$1 order by created_at desc`,
      [productId]
    );
    return rows;
  }

  async getApiKey(id, productId) {
    const { rows } = await this.pool.query(
      `select * from api_keys where id=$1 and ($2::text is null or product_id=$2)`,
      [id, productId ?? null]
    );
    return rows[0];
  }

  async rotateApiKey(id, productId, replacement) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const current = await client.query(
        `select * from api_keys where id=$1 and product_id=$2 for update`,
        [id, productId]
      );
      if (!current.rows[0] || current.rows[0].revoked_at) {
        await client.query("rollback");
        return null;
      }
      await client.query("update api_keys set revoked_at=now() where id=$1", [id]);
      const created = await client.query(
        `insert into api_keys (product_id, name, key_hash, scopes, expires_at, rotated_from_id)
         values ($1,$2,$3,$4,$5,$6) returning *`,
        [productId, replacement.name, replacement.key_hash, replacement.scopes, replacement.expires_at ?? null, id]
      );
      await client.query("commit");
      return created.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async revokeApiKey(id, productId) {
    const { rows } = await this.pool.query(
      `update api_keys set revoked_at=coalesce(revoked_at, now()) where id=$1 and product_id=$2 returning *`,
      [id, productId]
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

  async createComplianceScan(input) {
    const { rows } = await this.pool.query(
      `insert into compliance_scans
       (product_id, environment, scanned_at, tool_version, standard_version, score, max_score, grade, findings, verification)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) returning *`,
      [
        input.product_id,
        input.environment,
        input.scanned_at,
        input.tool_version,
        input.standard_version,
        input.score,
        input.max_score,
        input.grade,
        JSON.stringify(input.findings),
        JSON.stringify(input.verification)
      ]
    );
    return rows[0];
  }

  async listComplianceScans({ productId, limit = 100 } = {}) {
    const { rows } = await this.pool.query(
      `select * from compliance_scans ${productId ? "where product_id=$2" : ""}
       order by scanned_at desc limit $1`,
      productId ? [limit, productId] : [limit]
    );
    return rows;
  }

  async appendAuditLog(input) {
    const { rows } = await this.pool.query(
      `insert into audit_logs
       (product_id, actor_type, actor_id, action, target_type, target_id, source_ip, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) returning *`,
      [
        input.product_id ?? null,
        input.actor_type,
        input.actor_id ?? null,
        input.action,
        input.target_type,
        input.target_id ?? null,
        input.source_ip ?? null,
        JSON.stringify(input.metadata ?? {})
      ]
    );
    return rows[0];
  }

  async listAuditLogs({ productId, limit = 200 } = {}) {
    const { rows } = await this.pool.query(
      `select * from audit_logs ${productId ? "where product_id=$2" : ""}
       order by created_at desc limit $1`,
      productId ? [limit, productId] : [limit]
    );
    return rows;
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
        (select count(*)::int from alerts) as alerts,
        (select count(*)::int from alert_instances where status <> 'resolved') as active_alerts
    `);
    const statuses = [];
    for (const product of products) {
      for (const environment of productEnvironments(product)) {
        const [healthChecks, configuredMonitors, monitorRuns, activeAlerts, incidents] = await Promise.all([
          this.listHealth({ productId: product.product_id, environment }),
          this.listMonitors({ productId: product.product_id, environment }),
          this.listMonitorRuns({ productId: product.product_id, environment }),
          this.listAlertInstances({ productId: product.product_id, environment }),
          this.listIncidents({ productId: product.product_id, environment })
        ]);
        statuses.push(deriveEnvironmentStatus({ productId: product.product_id, environment, healthChecks, configuredMonitors, monitorRuns, activeAlerts, incidents }));
      }
    }
    const failingProducts = statuses.filter((item) => ["degraded", "outage"].includes(item.status)).length;
    return {
      products: products.length,
      ...counts.rows[0],
      failing_products: failingProducts,
      latest_health: latestHealth,
      events_by_product: await this.countByTable("telemetry_events"),
      errors_by_product: await this.countByTable("telemetry_errors"),
      recent_events: events,
      recent_errors: errors,
      status: aggregateFleetStatus(statuses)
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

function productEnvironments(product) {
  const values = (product.environments ?? []).map((item) => typeof item === "string" ? item : item.name).filter(Boolean);
  return values.length ? [...new Set(values)] : ["production"];
}

const RETENTION_TABLES = [
  ["events", "telemetry_events", "occurred_at"],
  ["errors", "telemetry_errors", "occurred_at"],
  ["health", "health_checks", "occurred_at"],
  ["monitorRuns", "monitor_runs", "checked_at"],
  ["alertDeliveries", "alert_deliveries", "delivered_at"],
  ["dedup", "ingest_dedup", "received_at"]
];

function operationalFilter({ productId, environment } = {}, startIndex = 1, extraConditions = []) {
  const conditions = [];
  const params = [];
  if (productId) {
    conditions.push(`product_id=$${startIndex + params.length}`);
    params.push(productId);
  }
  if (environment) {
    conditions.push(`environment=$${startIndex + params.length}`);
    params.push(environment);
  }
  conditions.push(...extraConditions);
  return { clause: conditions.length ? `where ${conditions.join(" and ")}` : "", params };
}

async function rollupPostgres(client, cutoff) {
  const statements = [
    `insert into daily_aggregates (bucket_date, product_id, environment, event_count)
     select (occurred_at at time zone 'UTC')::date, product_id, environment, count(*) from telemetry_events where occurred_at < $1 group by 1,2,3
     on conflict (bucket_date, product_id, environment) do update set event_count=daily_aggregates.event_count+excluded.event_count, updated_at=now()`,
    `insert into daily_aggregates (bucket_date, product_id, environment, error_count)
     select (occurred_at at time zone 'UTC')::date, product_id, environment, count(*) from telemetry_errors where occurred_at < $1 group by 1,2,3
     on conflict (bucket_date, product_id, environment) do update set error_count=daily_aggregates.error_count+excluded.error_count, updated_at=now()`,
    `insert into daily_aggregates (bucket_date, product_id, environment, health_ok_count, health_failure_count)
     select (occurred_at at time zone 'UTC')::date, product_id, environment, count(*) filter (where ok), count(*) filter (where not ok)
     from health_checks where occurred_at < $1 group by 1,2,3
     on conflict (bucket_date, product_id, environment) do update set
       health_ok_count=daily_aggregates.health_ok_count+excluded.health_ok_count,
       health_failure_count=daily_aggregates.health_failure_count+excluded.health_failure_count, updated_at=now()`,
    `insert into daily_aggregates (bucket_date, product_id, environment, monitor_ok_count, monitor_failure_count)
     select (checked_at at time zone 'UTC')::date, product_id, environment, count(*) filter (where ok), count(*) filter (where not ok)
     from monitor_runs where checked_at < $1 group by 1,2,3
     on conflict (bucket_date, product_id, environment) do update set
       monitor_ok_count=daily_aggregates.monitor_ok_count+excluded.monitor_ok_count,
       monitor_failure_count=daily_aggregates.monitor_failure_count+excluded.monitor_failure_count, updated_at=now()`,
    `insert into daily_aggregates (bucket_date, product_id, environment, alert_delivery_count)
     select (delivered_at at time zone 'UTC')::date, product_id, environment, count(*) from alert_deliveries where delivered_at < $1 group by 1,2,3
     on conflict (bucket_date, product_id, environment) do update set
       alert_delivery_count=daily_aggregates.alert_delivery_count+excluded.alert_delivery_count, updated_at=now()`
  ];
  for (const statement of statements) await client.query(statement, [cutoff]);
}
