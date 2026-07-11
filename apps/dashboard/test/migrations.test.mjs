import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PostgresStore } from "../src/stores/postgres-store.mjs";
import { loadMigrations } from "../src/stores/migrations.mjs";

class FakeDatabase {
  constructor() {
    this.applied = new Map();
    this.calls = [];
    this.client = {
      query: async (text, params = []) => this.query(text, params),
      release: () => this.calls.push({ kind: "release" })
    };
  }

  async connect() {
    this.calls.push({ kind: "connect" });
    return this.client;
  }

  async query(text, params = []) {
    const sql = String(text).trim();
    this.calls.push({ kind: "query", sql, params });
    if (/select\s+version\s*,\s*checksum\s+from\s+schema_migrations/i.test(sql)) {
      return { rows: [...this.applied].map(([version, checksum]) => ({ version, checksum })) };
    }
    if (/insert\s+into\s+schema_migrations/i.test(sql)) {
      this.applied.set(params[0], params[1]);
    }
    return { rows: [] };
  }
}

test("migrations use advisory locking, ordered version records, and one transaction per file", async () => {
  const database = new FakeDatabase();
  const store = new PostgresStore("postgres://unused");
  store.pool = database;

  await store.migrate();

  const sqlCalls = database.calls.filter((call) => call.kind === "query").map((call) => call.sql);
  assert.ok(sqlCalls.some((sql) => /pg_advisory_lock/i.test(sql)));
  assert.ok(sqlCalls.some((sql) => /pg_advisory_unlock/i.test(sql)));
  assert.deepEqual([...database.applied.keys()], ["001_initial", "002_phase2_foundations", "003_runtime_operations", "004_integrity_and_upgrade_safety"]);
  assert.equal(sqlCalls.filter((sql) => /^begin$/i.test(sql)).length, 4);
  assert.equal(sqlCalls.filter((sql) => /^commit$/i.test(sql)).length, 4);
  assert.ok(database.calls.some((call) => call.kind === "release"));
});

test("already-applied migrations are skipped and checksum drift fails closed", async () => {
  const database = new FakeDatabase();
  const store = new PostgresStore("postgres://unused");
  store.pool = database;
  await store.migrate();

  database.calls = [];
  await store.migrate();
  const secondRunTransactions = database.calls.filter(
    (call) => call.kind === "query" && /^begin$/i.test(call.sql)
  );
  assert.equal(secondRunTransactions.length, 0);

  database.applied.set("001_initial", "tampered-checksum");
  await assert.rejects(() => store.migrate(), /checksum/i);
});

test("migration checksums canonicalize SQL line endings and accept legacy CRLF hashes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "apr-migrations-"));
  const filename = path.join(directory, "001_probe.sql");
  try {
    await writeFile(filename, "select 1;\nselect 2;\n", "utf8");
    const [lf] = await loadMigrations(directory);
    await writeFile(filename, "select 1;\r\nselect 2;\r\n", "utf8");
    const [crlf] = await loadMigrations(directory);
    assert.equal(crlf.checksum, lf.checksum);

    const legacyChecksum = crlf.compatibleChecksums.find((checksum) => checksum !== crlf.checksum);
    assert.ok(legacyChecksum);
    const database = new FakeDatabase();
    database.applied.set(crlf.version, legacyChecksum);
    const store = new PostgresStore("postgres://unused", { migrationsDir: directory });
    store.pool = database;
    await store.migrate();
    assert.equal(database.calls.filter((call) => call.kind === "query" && /^begin$/i.test(call.sql)).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
