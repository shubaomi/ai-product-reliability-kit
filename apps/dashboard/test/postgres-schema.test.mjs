import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { hashSecret } from "../src/security.mjs";
import { createIncidentRecord, resolveIncident } from "../src/incident-lifecycle.mjs";
import { loadMigrations } from "../src/stores/migrations.mjs";
import { PostgresStore } from "../src/stores/postgres-store.mjs";

const databaseUrl = process.env.APR_TEST_DATABASE_URL;

if (!databaseUrl) {
  test("real PostgreSQL migrations, constraints, transactions, and runtime operations", {
    skip: "APR_TEST_DATABASE_URL is not configured"
  }, () => {});
  test("legacy schema upgrades preserve environment identity and prior-release writes remain safe", {
    skip: "APR_TEST_DATABASE_URL is not configured"
  }, () => {});
} else {
  test("real PostgreSQL migrations, constraints, transactions, and runtime operations", async () => {
    const isolated = await isolatedSchema(databaseUrl, "runtime");
    const first = new PostgresStore(isolated.databaseUrl);
    const second = new PostgresStore(isolated.databaseUrl);
    await Promise.all([first.ready(), second.ready()]);
    const productId = `phase2-pg-${crypto.randomUUID()}`;

    try {
      const migrations = await first.pool.query(
        "select version, checksum from schema_migrations order by version"
      );
      assert.deepEqual(migrations.rows.map((row) => row.version), [
        "001_initial",
        "002_phase2_foundations",
        "003_runtime_operations",
        "004_integrity_and_upgrade_safety"
      ]);
      assert.ok(migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(row.checksum)));

      const firstContactId = `first-contact-${crypto.randomUUID()}`;
      const firstContact = {
        schema_version: "1.1",
        type: "product",
        product_id: firstContactId,
        environment: "production",
        release: "onboarding",
        occurred_at: new Date().toISOString(),
        idempotency_key: "first-contact-product",
        payload: {
          contract: {
            standard_version: "1.1",
            product: { id: firstContactId, name: "First contact", owner: "owner@example.com" },
            environments: [{ name: "production", url: "https://example.com" }],
            critical_journeys: []
          }
        }
      };
      assert.equal((await first.appendIngestItems([firstContact])).accepted, 1);
      assert.equal((await first.appendIngestItems([firstContact])).accepted, 0);
      assert.equal((await first.getProduct(firstContactId)).name, "First contact");

      await first.upsertProduct({
        product_id: productId,
        name: "Phase 2 Postgres",
        owner: "owner@example.com",
        standard_version: "1.0"
      });

      const apiKey = await first.createApiKey({
        product_id: productId,
        name: "integration",
        key_hash: hashSecret("integration-secret"),
        scopes: ["ingest", "read"],
        expires_at: new Date(Date.now() + 60_000).toISOString()
      });
      assert.equal((await first.findApiKey(hashSecret("integration-secret"))).id, apiKey.id);
      await first.markApiKeyUsed(apiKey.id);
      assert.ok((await first.getApiKey(apiKey.id, productId)).last_used_at);

      const scan = await first.createComplianceScan({
        product_id: productId,
        environment: "local",
        scanned_at: new Date().toISOString(),
        tool_version: "1.0.0",
        standard_version: "1.0",
        score: 75,
        max_score: 100,
        grade: "B",
        findings: [],
        verification: { passed: 1 }
      });
      assert.equal(scan.product_id, productId);
      assert.equal((await first.listComplianceScans({ productId })).length, 1);

      await first.appendAuditLog({
        product_id: productId,
        actor_type: "master",
        action: "integration.checked",
        target_type: "product",
        target_id: productId,
        metadata: { safe: true }
      });
      assert.equal((await first.listAuditLogs({ productId })).length, 1);

      const validEvent = {
        schema_version: "1.0",
        type: "event",
        product_id: productId,
        environment: "production",
        release: "r1",
        occurred_at: new Date().toISOString(),
        payload: { event: "transaction_probe" }
      };
      await assert.rejects(() => first.appendIngestItems([
        validEvent,
        { ...validEvent, environment: null, payload: { event: "must_rollback" } }
      ]));
      const rolledBack = await first.pool.query(
        "select count(*)::int as count from telemetry_events where product_id=$1 and event_name='transaction_probe'",
        [productId]
      );
      assert.equal(rolledBack.rows[0].count, 0);

      const readiness = await first.readiness();
      assert.equal(readiness.ok, true);
      assert.equal(readiness.checks.store, true);
      assert.equal(readiness.checks.migrations, true);

      const now = new Date();
      await first.appendIngestItems([
        { ...validEvent, type: "health", environment: "production", payload: { ok: false }, occurred_at: now.toISOString() },
        { ...validEvent, type: "health", environment: "staging", payload: { ok: true }, occurred_at: now.toISOString() }
      ]);
      assert.equal((await first.listHealth({ productId, environment: "production" })).length, 1);
      assert.equal((await first.listHealth({ productId, environment: "staging" })).length, 1);

      const replayBatch = [
        { ...validEvent, environment: "production", idempotency_key: "shared-event-key", payload: { event: "dedup_probe" } },
        { ...validEvent, environment: "staging", idempotency_key: "shared-event-key", payload: { event: "dedup_probe" } },
        { ...validEvent, type: "error", idempotency_key: "error-key", payload: { name: "Error", message: "dedup" } },
        { ...validEvent, type: "health", idempotency_key: "health-key", payload: { ok: false, checks: { database: false } } }
      ];
      assert.equal((await first.appendIngestItems(replayBatch)).accepted, 4);
      assert.equal((await first.appendIngestItems(replayBatch)).accepted, 0);
      await assert.rejects(
        () => first.appendIngestItems([{ ...replayBatch[0], type: "health", payload: { ok: true, checks: {} } }]),
        (error) => error.status === 409 && /telemetry type event/.test(error.message)
      );
      const dedupCounts = await first.pool.query(
        `select
           (select count(*)::int from telemetry_events where product_id=$1 and event_name='dedup_probe') as events,
           (select count(*)::int from telemetry_errors where product_id=$1 and idempotency_key='error-key') as errors,
           (select count(*)::int from health_checks where product_id=$1 and idempotency_key='health-key') as health`,
        [productId]
      );
      assert.deepEqual(dedupCounts.rows[0], { events: 2, errors: 1, health: 1 });
      await assert.rejects(
        () => first.pool.query(
          `insert into telemetry_events
           (product_id, environment, release, event_name, idempotency_key, occurred_at, payload)
           values ($1,'production','r1','type_collision','error-key',now(),'{}'::jsonb)`,
          [productId]
        ),
        (error) => error.code === "23514"
      );

      const monitorId = `${productId}-healthz`;
      await first.appendMonitors([{
        id: monitorId, product_id: productId, environment: "production", type: "http", name: "Health",
        url: "https://example.com/healthz", severity: "critical", interval_seconds: 60
      }]);
      await first.recordMonitorRun({
        monitor_id: monitorId, product_id: productId, environment: "production", severity: "critical",
        failure_threshold: 2, interval_seconds: 60, ok: false, status: "500", checked_at: now.toISOString()
      });
      assert.equal((await first.listMonitorRuns({ productId, environment: "production" })).length, 1);

      const otherProductId = `${productId}-other`;
      await first.upsertProduct({
        product_id: otherProductId,
        name: "Other owner",
        owner: "other@example.com",
        standard_version: "1.1"
      });
      await assert.rejects(
        () => first.recordMonitorRun({ monitor_id: monitorId, product_id: otherProductId, environment: "production", ok: true, status: "200" }),
        (error) => error.code === "23514"
      );
      await assert.rejects(
        () => first.appendMonitors([
          { id: `${otherProductId}-new`, product_id: otherProductId, environment: "staging", type: "http", name: "Must roll back", url: "https://example.org" },
          { id: monitorId, product_id: otherProductId, environment: "staging", type: "http", name: "Collision", url: "https://example.org" }
        ]),
        (error) => error.status === 409
      );
      assert.equal((await first.listMonitors({ productId: otherProductId })).length, 0, "ownership conflict rolls back the entire batch");

      const ruleId = `${productId}-availability`;
      await first.appendAlerts([{
        id: ruleId, product_id: productId, environment: "production", type: "availability_failure",
        monitor_id: monitorId, name: "Availability", severity: "critical", consecutive_failures: 2
      }]);
      await assert.rejects(
        () => first.appendAlerts([
          { id: `${otherProductId}-new-alert`, product_id: otherProductId, environment: "staging", type: "telemetry_stale", name: "Must roll back" },
          { id: ruleId, product_id: otherProductId, environment: "staging", type: "error_spike", name: "Collision" }
        ]),
        (error) => error.status === 409
      );
      assert.equal((await first.listAlerts({ productId: otherProductId })).length, 0, "alert ownership conflict rolls back the entire batch");
      const alert = await first.upsertAlertInstance({
        rule_id: ruleId, product_id: productId, environment: "production", dedup_key: `${productId}:production:availability_failure:${monitorId}`,
        name: "Availability", severity: "critical", status: "open", reason: "failed", evidence: {},
        opened_at: now.toISOString(), last_seen_at: now.toISOString(), occurrence_count: 1
      });
      assert.equal((await first.acknowledgeAlertInstance(alert.id, { actor: "operator" })).status, "acknowledged");

      await first.appendAlerts([{
        id: `${otherProductId}-alert`, product_id: otherProductId, environment: "staging",
        type: "telemetry_stale", name: "Other alert"
      }]);
      await assert.rejects(
        () => first.appendAlertDelivery({
          alert_id: ruleId, product_id: otherProductId, environment: "staging",
          channel: "generic", status: "sent", message: "must reject"
        }),
        (error) => error.code === "23514"
      );
      await assert.rejects(
        () => first.upsertAlertInstance({
          rule_id: `${otherProductId}-alert`, rule_type: "telemetry_stale", product_id: otherProductId,
          environment: "staging", dedup_key: `${productId}:production:availability_failure:${monitorId}`,
          name: "Collision", severity: "high", status: "open", opened_at: now.toISOString(), last_seen_at: now.toISOString()
        }),
        (error) => error.status === 409
      );

      await assert.rejects(
        () => first.appendStatusPages([{ product_id: productId, public_slug: otherProductId, title: "Impersonation", body: "", generated_at: now.toISOString() }]),
        (error) => error.status === 409
      );
      await first.appendStatusPages([{ product_id: productId, public_slug: `${productId}-status`, title: "Primary", body: "", generated_at: now.toISOString() }]);
      await assert.rejects(
        () => first.appendStatusPages([
          { product_id: otherProductId, public_slug: `${otherProductId}-status`, title: "Must roll back", body: "", generated_at: now.toISOString() },
          { product_id: otherProductId, public_slug: `${productId}-status`, title: "Collision", body: "", generated_at: now.toISOString() }
        ]),
        (error) => error.status === 409
      );
      assert.equal((await first.listStatusPages({ productId: otherProductId })).length, 0, "status-page conflict rolls back the entire batch");
      await assert.rejects(
        () => first.appendStatusPages([{ product_id: productId, public_slug: `${productId}-second`, title: "Second", body: "", generated_at: now.toISOString() }]),
        (error) => error.status === 409
      );
      const namespaceOwnerId = `${productId}-namespace-owner`;
      const futureProductId = `${productId}-future`;
      await first.upsertProduct({ product_id: namespaceOwnerId, name: "Namespace owner", owner: "owner@example.com", standard_version: "1.1" });
      await first.appendStatusPages([{ product_id: namespaceOwnerId, public_slug: futureProductId, title: "Reserved", body: "", generated_at: now.toISOString() }]);
      await assert.rejects(
        () => first.upsertProduct({ product_id: futureProductId, name: "Future", owner: "owner@example.com", standard_version: "1.1" }),
        (error) => error.status === 409
      );

      let incident = createIncidentRecord({ product_id: productId, environment: "production", title: "Outage", severity: "critical" });
      incident = await first.createIncident(incident);
      incident = resolveIncident(incident, { actor: "operator", recovery_note: "Restored and verified." });
      assert.equal((await first.updateIncident(incident)).status, "resolved");

      await first.createMaintenanceWindow({
        product_id: productId, environment: "production", name: "Deploy",
        starts_at: new Date(now.getTime() - 1000).toISOString(), ends_at: new Date(now.getTime() + 60_000).toISOString()
      });
      assert.equal((await first.listMaintenanceWindows({ productId, environment: "production", activeAt: now.toISOString() })).length, 1);

      let entered;
      let release;
      const enteredPromise = new Promise((resolve) => { entered = resolve; });
      const releasePromise = new Promise((resolve) => { release = resolve; });
      const held = first.withSchedulerLease(async () => { entered(); await releasePromise; });
      await enteredPromise;
      const denied = await second.withSchedulerLease(async () => "unexpected");
      assert.equal(denied.acquired, false);
      release();
      await held;

      await first.appendIngestItems([{
        ...validEvent,
        idempotency_key: crypto.randomUUID(),
        occurred_at: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
        payload: { event: "retention_probe" }
      }]);
      const retention = await Promise.all([
        first.runRetention({ rawRetentionDays: 7 }, now),
        second.runRetention({ rawRetentionDays: 7 }, now)
      ]);
      assert.ok(retention.reduce((total, result) => total + result.deleted.events, 0) >= 1);
      const expectedBucket = new Date(now.getTime() - 10 * 86_400_000).toISOString().slice(0, 10);
      const aggregate = (await first.listDailyAggregates({ productId, environment: "production" }))
        .find((item) => String(item.bucket_date).slice(0, 10) === expectedBucket);
      assert.equal(Number(aggregate?.event_count), 1, "concurrent retention must not double-count the same raw row");
    } finally {
      await Promise.all([first.close(), second.close()]);
      await isolated.cleanup();
    }
  });

  test("legacy schema upgrades preserve environment identity and prior-release writes remain safe", async () => {
    const isolated = await isolatedSchema(databaseUrl, "upgrade");
    const { Pool } = await import("pg");
    const legacyPool = new Pool({ connectionString: isolated.databaseUrl });
    let upgraded;
    try {
      const migrations = await loadMigrations();
      for (const migration of migrations.slice(0, 2)) await legacyPool.query(migration.sql);
      await legacyPool.query(`
        create table schema_migrations (
          version text primary key,
          checksum text not null,
          applied_at timestamptz not null default now()
        )
      `);
      for (const migration of migrations.slice(0, 2)) {
        await legacyPool.query(
          "insert into schema_migrations (version, checksum) values ($1,$2)",
          [migration.version, migration.checksum]
        );
      }

      await legacyPool.query(
        `insert into products (product_id, name, owner, standard_version)
         values ('legacy-product','Legacy product','owner@example.com','1.0')`
      );
      const chainedKeySource = "legacy-chain-source";
      const chainedKeyTarget = `production:${crypto.createHash("sha256").update(chainedKeySource).digest("hex")}`;
      await legacyPool.query(
        `insert into telemetry_events
         (product_id, environment, release, event_name, idempotency_key, occurred_at, payload)
         values
           ('legacy-product','production','legacy','legacy.chain.source',$1,now(),'{}'::jsonb),
           ('legacy-product','production','legacy','legacy.chain.target',$2,now(),'{}'::jsonb)`,
        [chainedKeySource, chainedKeyTarget]
      );
      await legacyPool.query(
        `insert into monitors (id, product_id, type, name, config, severity)
         values ('legacy-monitor','legacy-product','http','Legacy monitor',
           '{"environment":"staging","failure_threshold":3,"interval_seconds":45}'::jsonb,'critical')`
      );
      await legacyPool.query(
        `insert into monitor_runs (monitor_id, product_id, ok, status, details)
         values ('legacy-monitor','legacy-product',false,'500','{}'::jsonb)`
      );
      await legacyPool.query(
        `insert into alerts (id, product_id, name, condition, severity, notify, enabled)
         values ('legacy-alert','legacy-product','Legacy stale','telemetry stale for five minutes','high','[]'::jsonb,true)`
      );
      await legacyPool.query(
        `insert into alert_deliveries (alert_id, product_id, channel, status, message)
         values ('legacy-alert','legacy-product','generic','sent','legacy')`
      );
      await legacyPool.query(
        `insert into status_pages (product_id,title,body,public_slug,generated_at)
         values
           ('legacy-product','Older','old','legacy-old',now() - interval '1 day'),
           ('legacy-product','Current','new','legacy-current',now())`
      );

      upgraded = new PostgresStore(isolated.databaseUrl);
      await upgraded.ready();

      const monitor = (await upgraded.listMonitors({ productId: "legacy-product", environment: "staging" }))[0];
      assert.equal(monitor.id, "legacy-monitor");
      const run = (await upgraded.listMonitorRuns({ productId: "legacy-product", environment: "staging" }))[0];
      assert.equal(run.severity, "critical");
      assert.equal(run.failure_threshold, 3);
      assert.equal(run.interval_seconds, 45);

      const legacyAlert = (await upgraded.listAlerts({ productId: "legacy-product" }))[0];
      assert.equal(legacyAlert.enabled, false);
      assert.equal(legacyAlert.legacy_migration, true);
      assert.match(legacyAlert.migration_advice, /recreate/i);
      const delivery = await upgraded.pool.query("select environment from alert_deliveries where alert_id='legacy-alert'");
      assert.equal(delivery.rows[0].environment, "production");
      assert.equal((await upgraded.listStatusPages({ productId: "legacy-product" })).length, 1);
      assert.equal((await upgraded.pool.query("select count(*)::int as count from status_pages_migration_archive")).rows[0].count, 1);
      const upgradedKeys = await upgraded.pool.query(
        `select original_idempotency_key from telemetry_events
         where product_id='legacy-product' and event_name like 'legacy.chain.%'
         order by original_idempotency_key`
      );
      assert.deepEqual(upgradedKeys.rows.map((row) => row.original_idempotency_key), [chainedKeySource, chainedKeyTarget].sort());

      const legacyEventSql = `insert into telemetry_events
        (product_id, environment, release, event_name, anonymous_id, user_id, request_id, idempotency_key, occurred_at, payload)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        on conflict (product_id, idempotency_key) do nothing`;
      const legacyEventTime = new Date().toISOString();
      await upgraded.pool.query(legacyEventSql, ["legacy-product", "staging", "legacy", "rollback.event", null, null, null, "rollback-event-key", legacyEventTime, "{}"]);
      assert.equal((await upgraded.appendIngestItems([{
        schema_version: "1.0",
        type: "event",
        product_id: "legacy-product",
        environment: "staging",
        release: "legacy",
        idempotency_key: "rollback-event-key",
        occurred_at: legacyEventTime,
        payload: { event: "rollback.event" }
      }])).accepted, 0, "new code must treat a legacy-window event write as an existing idempotent item");
      await upgraded.upsertProduct({ product_id: "legacy-other", name: "Legacy other", owner: "owner@example.com", standard_version: "1.1" });
      await assert.rejects(
        () => upgraded.pool.query(
          "update telemetry_events set product_id='legacy-other' where product_id='legacy-product' and original_idempotency_key=$1",
          ["rollback-event-key"]
        ),
        (error) => error.code === "23514"
      );

      await upgraded.pool.query(
        `insert into monitors (id, product_id, type, name, config, severity, enabled, updated_at)
         values ($1,$2,$3,$4,$5::jsonb,$6,true,now())
         on conflict (id) do update set name=excluded.name, config=excluded.config,
           severity=excluded.severity, enabled=true, updated_at=now()`,
        ["rollback-monitor", "legacy-product", "http", "Rollback monitor", JSON.stringify({ environment: "staging", failure_threshold: 4, interval_seconds: 30 }), "critical"]
      );
      await upgraded.pool.query(
        `insert into monitor_runs (monitor_id, product_id, ok, status, latency_ms, details)
         values ($1,$2,$3,$4,$5,$6::jsonb)`,
        ["rollback-monitor", "legacy-product", false, "500", 10, "{}"]
      );
      const rollbackRun = await upgraded.pool.query("select environment, severity, failure_threshold, interval_seconds from monitor_runs where monitor_id='rollback-monitor'");
      assert.deepEqual(rollbackRun.rows[0], { environment: "staging", severity: "critical", failure_threshold: 4, interval_seconds: 30 });

      const legacyAlertSql = `insert into alerts (id, product_id, name, condition, severity, notify, action, enabled, updated_at)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7,true,now())
        on conflict (id) do update set name=excluded.name, condition=excluded.condition,
          severity=excluded.severity, notify=excluded.notify, action=excluded.action, enabled=true, updated_at=now()`;
      const legacyAlertParams = ["rollback-alert", "legacy-product", "Rollback alert", "error spike", "high", "[]", "investigate"];
      await upgraded.pool.query(legacyAlertSql, legacyAlertParams);
      await upgraded.pool.query(legacyAlertSql, legacyAlertParams);
      const rollbackAlert = await upgraded.pool.query("select type, enabled, config from alerts where id='rollback-alert'");
      assert.equal(rollbackAlert.rows[0].type, "error_spike");
      assert.equal(rollbackAlert.rows[0].enabled, false);
      assert.equal(rollbackAlert.rows[0].config.legacy_migration, true);

      const legacyInstanceSql = `insert into alert_instances
        (rule_id, product_id, environment, dedup_key, name, severity, status, reason, evidence,
         opened_at, last_seen_at, occurrence_count, updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,now())
        on conflict (dedup_key) do update set status=excluded.status, reason=excluded.reason,
          evidence=excluded.evidence, last_seen_at=excluded.last_seen_at,
          occurrence_count=excluded.occurrence_count, updated_at=now()
        returning rule_type`;
      const legacyInstanceParams = [
        "rollback-alert", "legacy-product", "production", "legacy-product:production:rollback-alert-dedup", "Rollback alert",
        "high", "open", "legacy worker", "{}", new Date().toISOString(), new Date().toISOString(), 1
      ];
      const legacyInstance = await upgraded.pool.query(legacyInstanceSql, legacyInstanceParams);
      assert.equal(legacyInstance.rows[0].rule_type, "error_spike");
      const legacyInstanceReplay = await upgraded.pool.query(legacyInstanceSql, legacyInstanceParams);
      assert.equal(legacyInstanceReplay.rows[0].rule_type, "error_spike");
      await assert.rejects(
        () => upgraded.pool.query(
          "update alert_instances set dedup_key='other-product:staging:escape' where dedup_key=$1",
          ["legacy-product:production:rollback-alert-dedup"]
        ),
        (error) => error.code === "23514"
      );
    } finally {
      await upgraded?.close();
      await legacyPool.end();
      await isolated.cleanup();
    }
  });
}

async function isolatedSchema(baseDatabaseUrl, label) {
  const { Pool } = await import("pg");
  const admin = new Pool({ connectionString: baseDatabaseUrl });
  const schema = `apr_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`create schema "${schema}"`);
  const scoped = new URL(baseDatabaseUrl);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  return {
    databaseUrl: scoped.toString(),
    async cleanup() {
      await admin.query(`drop schema if exists "${schema}" cascade`);
      await admin.end();
    }
  };
}
