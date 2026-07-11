import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "../../db/migrations");
const MIGRATION_LOCK_ID = "4242424242";

export async function loadMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const names = (await fs.readdir(migrationsDir))
    .filter((name) => /^\d{3}_[a-z0-9_-]+\.sql$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  const migrations = [];
  for (const name of names) {
    const rawSql = await fs.readFile(path.join(migrationsDir, name), "utf8");
    const sql = canonicalizeSql(rawSql);
    const checksum = hashSql(sql);
    migrations.push({
      version: name.replace(/\.sql$/i, ""),
      name,
      sql,
      checksum,
      compatibleChecksums: [...new Set([
        checksum,
        hashSql(rawSql),
        hashSql(sql.replace(/\n/g, "\r\n"))
      ])]
    });
  }
  if (!migrations.length) throw new Error(`No migration files found in ${migrationsDir}`);
  return migrations;
}

export async function runMigrations(pool, options = {}) {
  const migrations = await loadMigrations(options.migrationsDir);
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock($1::bigint)", [MIGRATION_LOCK_ID]);
    locked = true;
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows } = await client.query("select version, checksum from schema_migrations order by version");
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));

    for (const migration of migrations) {
      const existingChecksum = applied.get(migration.version);
      if (existingChecksum) {
        if (!migration.compatibleChecksums.includes(existingChecksum)) {
          throw new Error(`Migration checksum mismatch for ${migration.version}`);
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, checksum) values ($1, $2)",
          [migration.version, migration.checksum]
        );
        await client.query("commit");
        applied.set(migration.version, migration.checksum);
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${migration.version} failed: ${error.message}`, { cause: error });
      }
    }
    return { applied: [...applied.keys()].sort(), latest: migrations.at(-1).version };
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

export async function migrationReadiness(pool, options = {}) {
  const migrations = await loadMigrations(options.migrationsDir);
  try {
    const { rows } = await pool.query("select version, checksum from schema_migrations order by version");
    const applied = new Map(rows.map((row) => [row.version, row.checksum]));
    const ready = migrations.every((migration) => migration.compatibleChecksums.includes(applied.get(migration.version)));
    return {
      ready,
      expected: migrations.map((migration) => migration.version),
      applied: [...applied.keys()].sort(),
      latest: migrations.at(-1).version
    };
  } catch {
    return {
      ready: false,
      expected: migrations.map((migration) => migration.version),
      applied: [],
      latest: migrations.at(-1).version
    };
  }
}

function canonicalizeSql(sql) {
  return sql.replace(/\r\n?/g, "\n");
}

function hashSql(sql) {
  return crypto.createHash("sha256").update(sql).digest("hex");
}
