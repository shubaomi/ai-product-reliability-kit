import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bash = findBash();
const supportsReleaseSymlinks = Boolean(bash) && process.platform !== "win32";
const require = createRequire(import.meta.url);

test("deployment scripts expose the production-safe release contract", async () => {
  const deploy = await fs.readFile(path.join(repoRoot, "deploy.sh"), "utf8");
  const rollback = await fs.readFile(path.join(repoRoot, "rollback.sh"), "utf8");
  const common = await fs.readFile(path.join(repoRoot, "scripts/ops/common.sh"), "utf8");

  assert.doesNotMatch(deploy, /pm2\s+delete/, "deploy must never delete the PM2 process");
  assert.doesNotMatch(rollback, /pm2\s+delete/, "rollback must never delete the PM2 process");
  for (const required of ["releases", "current", "pm2 reload", "backup-postgres", "/healthz", "/readyz", "ai-product-reliability-worker", "ops_acquire_release_lock", "ops_assert_production_topology", "ops_check_pm2_stack_stable"]) {
    assert.match(`${deploy}\n${common}`, new RegExp(escapeRegExp(required)), `deployment contract is missing ${required}`);
  }
  assert.match(deploy, /--include ['"]\.env\.example['"]/);
  assert.match(deploy, /--exclude ['"]\.env\*['"]/);
  assert.match(deploy, /ALLOW_DIRTY_SOURCE/);
  assert.match(deploy, /\.release-ready/);
  assert.match(rollback, /\.deploy-failed/);
  assert.match(rollback, /\.release-ready/);
});

test("scheduled backup runs as the production service account with a daily label and writable log policy", async () => {
  const cron = await fs.readFile(path.join(repoRoot, "deploy", "cron", "ai-product-reliability-backup.cron"), "utf8");
  const logrotate = await fs.readFile(path.join(repoRoot, "deploy", "cron", "ai-product-reliability-backup.logrotate"), "utf8");

  assert.match(cron, /^17 2 \* \* \* apr\s/m);
  assert.match(cron, /BACKUP_LABEL=daily/);
  assert.doesNotMatch(cron, /restricted root-owned wrapper/);
  assert.match(logrotate, /create\s+0640\s+apr\s+apr/);
});

test("PM2 ecosystem runs one API and one independently configured worker", async () => {
  const configPath = path.join(repoRoot, "deploy", "ecosystem.config.cjs");
  const previous = {
    APR_CURRENT_LINK: process.env.APR_CURRENT_LINK,
    APR_API_APP_NAME: process.env.APR_API_APP_NAME,
    APR_WORKER_APP_NAME: process.env.APR_WORKER_APP_NAME
  };
  process.env.APR_CURRENT_LINK = "/tmp/apr-current";
  process.env.APR_API_APP_NAME = "test-api";
  process.env.APR_WORKER_APP_NAME = "test-worker";
  delete require.cache[require.resolve(configPath)];
  try {
    const config = require(configPath);
    assert.equal(config.apps.length, 2);
    const api = config.apps.find((app) => app.name === "test-api");
    const worker = config.apps.find((app) => app.name === "test-worker");
    assert.equal(api.script, "/tmp/apr-current/apps/dashboard/server.mjs");
    assert.equal(api.instances, 1);
    assert.equal(api.env_production.APR_PROCESS_ROLE, "api");
    assert.equal(api.env_production.APR_WORKER_ENABLED, "false");
    assert.equal(worker.script, "/tmp/apr-current/apps/dashboard/worker.mjs");
    assert.equal(worker.instances, 1);
    assert.equal(worker.env_production.APR_PROCESS_ROLE, "worker");
    assert.equal(worker.env_production.APR_WORKER_ENABLED, "true");
    assert.equal(worker.kill_timeout >= 30_000, true);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[require.resolve(configPath)];
  }
});

test("PM2 stability acceptance requires both named roles online beyond minimum uptime", { skip: !bash }, async (t) => {
  const fixture = await createFixture(t, { withLinks: false });
  const command = 'export PATH="$OPS_TEST_BIN:$PATH"; . "$OPS_COMMON"; ops_check_pm2_stack_stable ai-product-reliability-kit ai-product-reliability-worker 1 0 10000';
  const env = {
    ...process.env,
    ...fixture.env,
    OPS_COMMON: toBashPath(path.join(repoRoot, "scripts", "ops", "common.sh"))
  };
  let result = spawnSync(bash, ["-c", command], { cwd: repoRoot, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  result = spawnSync(bash, ["-c", command], {
    cwd: repoRoot,
    env: { ...env, OPS_TEST_PM2_UNSTABLE: "1" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0, "an offline worker must fail stability acceptance");
});

test("successful deploy switches current atomically and reloads PM2", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t);
  const result = runRepoScript("deploy.sh", fixture.env);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(resolveLink(fixture.currentLink), fixture.newRelease);
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.match(log, /pg_dump/);
  assert.match(log, /npm run migrate/);
  assert.match(log, /pm2 reload .*ecosystem\.config\.cjs --env production --update-env/);
  assert.doesNotMatch(log, /pm2 delete/);
  assert.match(await fs.readFile(path.join(fixture.newRelease, ".release-source"), "utf8"), /git_commit=[0-9a-f]{40}/);
  await fs.access(path.join(fixture.newRelease, ".release-ready"));
  await fs.access(path.join(fixture.newRelease, ".env.example"));
  await assert.rejects(fs.access(path.join(fixture.newRelease, ".env.production")));
});

test("failed post-switch acceptance restores the previous release", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { releaseId: "20260102-failed" });
  const result = runRepoScript("deploy.sh", { ...fixture.env, OPS_TEST_FAIL_ACCEPTANCE: "1" });

  assert.notEqual(result.status, 0, "failed acceptance must fail deployment");
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.equal((log.match(/pm2 reload .*ecosystem\.config\.cjs --env production --update-env/g) ?? []).length, 2);
});

test("failed PM2 reload restores the previous release and retries the old process", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { releaseId: "20260102-reload-failed" });
  const result = runRepoScript("deploy.sh", { ...fixture.env, OPS_TEST_FAIL_RELOAD_ONCE: "1" });

  assert.notEqual(result.status, 0, "failed PM2 reload must fail deployment");
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.equal((log.match(/pm2 reload /g) ?? []).length, 2);
});

test("an unstable PM2 worker fails acceptance and restores the previous release", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { releaseId: "20260102-worker-unstable" });
  const result = runRepoScript("deploy.sh", { ...fixture.env, OPS_TEST_PM2_UNSTABLE: "1" });

  assert.notEqual(result.status, 0, "an unstable worker must fail deployment");
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);
});

test("a failed PM2 state save restores the previous release", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { releaseId: "20260102-save-failed" });
  const result = runRepoScript("deploy.sh", { ...fixture.env, OPS_TEST_FAIL_SAVE_ONCE: "1" });

  assert.notEqual(result.status, 0, "a failed PM2 save must fail deployment");
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);
});

test("independent rollback selects previous and restores original on failed acceptance", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { currentIsNew: true, releaseId: "20260103-current" });
  let result = runRepoScript("rollback.sh", fixture.env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);

  await switchLink(fixture.currentLink, fixture.newRelease);
  await switchLink(fixture.previousLink, fixture.oldRelease);
  result = runRepoScript("rollback.sh", { ...fixture.env, OPS_TEST_FAIL_ACCEPTANCE: "1" });
  assert.notEqual(result.status, 0);
  assert.equal(resolveLink(fixture.currentLink), fixture.newRelease);
});

test("rollback rejects failed and incomplete release targets", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t, { currentIsNew: true, releaseId: "20260103-current" });
  await fs.writeFile(path.join(fixture.oldRelease, ".deploy-failed"), "failed\n");
  let result = runRepoScript("rollback.sh", fixture.env);
  assert.notEqual(result.status, 0);
  assert.equal(resolveLink(fixture.currentLink), fixture.newRelease);

  await fs.rm(path.join(fixture.oldRelease, ".deploy-failed"));
  await fs.rm(path.join(fixture.oldRelease, "apps", "dashboard", "worker.mjs"));
  result = runRepoScript("rollback.sh", fixture.env);
  assert.notEqual(result.status, 0);
  assert.equal(resolveLink(fixture.currentLink), fixture.newRelease);
});

test("deploy and rollback share an exclusive release-operation lock", { skip: !supportsReleaseSymlinks }, async (t) => {
  const fixture = await createFixture(t);
  const script = toBashPath(path.join(repoRoot, "deploy.sh"));
  const lockPath = toBashPath(path.join(fixture.prodDir, ".release-operation.lock"));
  const readyPath = toBashPath(path.join(fixture.root, "lock-ready"));
  const result = spawnSync(bash, ["-c", `
    set -euo pipefail
    export LOCK_PATH READY_PATH
    flock "$LOCK_PATH" -c 'touch "$READY_PATH"; sleep 30' &
    holder=$!
    trap 'kill "$holder" >/dev/null 2>&1 || true; wait "$holder" >/dev/null 2>&1 || true' EXIT
    for _ in {1..50}; do [[ -f "$READY_PATH" ]] && break; sleep 0.02; done
    [[ -f "$READY_PATH" ]]
    export PATH="$OPS_TEST_BIN:$PATH"
    if bash "$OPS_SCRIPT"; then exit 0; else exit $?; fi
  `], {
    cwd: repoRoot,
    env: { ...process.env, ...fixture.env, OPS_SCRIPT: script, LOCK_PATH: lockPath, READY_PATH: readyPath },
    encoding: "utf8"
  });

  assert.notEqual(result.status, 0, "deploy must fail while the shared lock is held");
  assert.match(result.stderr, /holds the release lock/);
  assert.equal(resolveLink(fixture.currentLink), fixture.oldRelease);
});

test("backup, verification, destructive restore guard, and disposable drill execute real command boundaries", { skip: !bash }, async (t) => {
  const fixture = await createFixture(t, { withLinks: false });
  const backupResult = runRepoScript("scripts/ops/backup-postgres.sh", fixture.env);
  assert.equal(backupResult.status, 0, backupResult.stderr);

  const dumps = (await fs.readdir(fixture.backupDir)).filter((name) => name.endsWith(".dump"));
  assert.equal(dumps.length, 1);
  const backup = path.join(fixture.backupDir, dumps[0]);
  assert.equal((await fs.stat(backup)).size > 0, true);
  assert.equal((await fs.stat(`${backup}.sha256`)).size > 0, true);

  const verify = runRepoScript("scripts/ops/verify-backup.sh", {
    ...fixture.env,
    BACKUP_FILE: toBashPath(backup)
  });
  assert.equal(verify.status, 0, verify.stderr);

  const deniedRestore = runRepoScript("scripts/ops/restore-postgres.sh", {
    ...fixture.env,
    BACKUP_FILE: toBashPath(backup)
  });
  assert.notEqual(deniedRestore.status, 0, "restore must require an explicit destructive confirmation");

  const restore = runRepoScript("scripts/ops/restore-postgres.sh", {
    ...fixture.env,
    BACKUP_FILE: toBashPath(backup),
    RESTORE_ALLOW_DESTRUCTIVE: "YES",
    RESTORE_CONFIRM_DATABASE: "ops_test"
  });
  assert.equal(restore.status, 0, `${restore.stderr}\n${await fs.readFile(fixture.logPath, "utf8")}`);
  const restoreLog = await fs.readFile(fixture.logPath, "utf8");
  assert.match(
    restoreLog,
    /pg_restore .*--dbname=postgresql:\/\/ops:secret@127\.0\.0\.1:5432\/ops_test .*\.dump/,
    "pg_restore must explicitly restore into the confirmed target database"
  );

  const drill = runRepoScript("scripts/ops/restore-drill.sh", {
    ...fixture.env,
    BACKUP_FILE: toBashPath(backup),
    DATABASE_ADMIN_URL: "postgresql://ops:secret@127.0.0.1:5432/postgres?sslmode=require"
  });
  assert.equal(drill.status, 0, drill.stderr);
  const log = await fs.readFile(fixture.logPath, "utf8");
  assert.match(log, /createdb/);
  assert.match(log, /pg_restore/);
  assert.match(log, /pg_restore .*--dbname=postgresql:\/\/ops:secret@127\.0\.0\.1:5432\/apr_restore_drill_[^ ]+\?sslmode=require/, "restore drill must preserve required connection parameters");
  assert.match(log, /dropdb/);

  const expired = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await fs.utimes(backup, expired, expired);
  const prune = runRepoScript("scripts/ops/prune-backups.sh", {
    ...fixture.env,
    BACKUP_RETENTION_DAYS: "1"
  });
  assert.equal(prune.status, 0, prune.stderr);
  await assert.rejects(fs.stat(backup), { code: "ENOENT" });
});

test("release retention removes only releases beyond the configured newest set", { skip: !bash }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apr-release-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const prodDir = path.join(root, "prod");
  const releasesDir = path.join(prodDir, "releases");
  for (const name of ["20260101-a", "20260102-b", "20260103-c", "20260104-d"]) {
    await fs.mkdir(path.join(releasesDir, name), { recursive: true });
  }

  const result = runRepoScript("scripts/ops/prune-releases.sh", {
    PROD_DIR: toBashPath(prodDir),
    RELEASES_DIR: toBashPath(releasesDir),
    KEEP_RELEASES: "2",
    OPS_TEST_BIN: ""
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await fs.readdir(releasesDir)).sort(), ["20260103-c", "20260104-d"]);
});

test("manual Linux validation documents production gates without GitHub automation", async () => {
  const workflowDirectory = path.join(repoRoot, ".github/workflows");
  const workflowFiles = await fs.readdir(workflowDirectory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const acceptance = await fs.readFile(path.join(repoRoot, "docs/deployment-acceptance.md"), "utf8");
  const serverGuide = await fs.readFile(path.join(repoRoot, "docs/server-deployment-guide.md"), "utf8");
  const manualValidation = `${acceptance}\n${serverGuide}`;
  const packageLock = JSON.parse(await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8"));

  assert.equal(packageLock.lockfileVersion >= 3, true);
  assert.deepEqual(workflowFiles.filter((name) => /\.ya?ml$/i.test(name)), []);
  await assert.rejects(fs.access(path.join(repoRoot, ".github/dependabot.yml")), { code: "ENOENT" });
  for (const required of ["npm ci", "test:postgres", "test:e2e", "mvn", "shellcheck", "nginx -t", "npm audit", "restore drill", "previous-release restoration"]) {
    assert.match(manualValidation, new RegExp(escapeRegExp(required), "i"), `Manual validation is missing ${required}`);
  }
});

async function createFixture(t, options = {}) {
  assert.ok(bash, "Bash is required for operation script behavior tests");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "apr-ops-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const prodDir = path.join(root, "prod");
  const releasesDir = path.join(prodDir, "releases");
  const oldRelease = path.join(releasesDir, "20260101-old");
  const releaseId = options.releaseId ?? "20260102-new";
  const newRelease = path.join(releasesDir, releaseId);
  const currentLink = path.join(prodDir, "current");
  const previousLink = path.join(prodDir, "previous");
  const fakeBin = path.join(root, "bin");
  const logPath = path.join(root, "commands.log");
  const backupDir = path.join(prodDir, "shared", "backups");
  await fs.mkdir(path.join(oldRelease, "apps", "dashboard"), { recursive: true });
  await fs.mkdir(fakeBin, { recursive: true });
  await fs.writeFile(path.join(oldRelease, "apps", "dashboard", "server.mjs"), "// old release\n");
  await fs.writeFile(path.join(oldRelease, "apps", "dashboard", "worker.mjs"), "// old worker\n");
  await fs.mkdir(path.join(oldRelease, "deploy"), { recursive: true });
  await fs.writeFile(path.join(oldRelease, "deploy", "ecosystem.config.cjs"), "module.exports = { apps: [] };\n");
  await fs.writeFile(path.join(oldRelease, ".release-ready"), "ready\n");
  await fs.writeFile(path.join(prodDir, ".env.production"), [
    "NODE_ENV=production",
    "HOST=127.0.0.1",
    "PORT=8787",
    "PUBLIC_BASE_URL=https://reliability.hihongrun.com",
    "APR_STORE_MODE=postgres",
    "APR_AUTH_REQUIRED=true",
    "DATABASE_URL=postgresql://ops:secret@127.0.0.1:5432/ops_test",
    "APR_ADMIN_EMAIL=ops@hihongrun.com",
    `APR_ADMIN_PASSWORD_HASH='pbkdf2_sha256$210000$0123456789abcdef$${"a".repeat(64)}'`,
    `APR_MASTER_API_KEY=${"m".repeat(40)}`,
    `APR_INGEST_API_KEY=${"i".repeat(40)}`,
    `APR_SESSION_SECRET=${"s".repeat(40)}`,
    `APR_USER_ID_HMAC_SECRET=${"u".repeat(40)}`,
    "APR_TRUSTED_PROXIES=127.0.0.1"
  ].join("\n") + "\n");
  await fs.chmod(path.join(prodDir, ".env.production"), 0o600);
  await fs.writeFile(logPath, "");
  await installFakeCommands(fakeBin);
  if (options.withLinks !== false) {
    if (options.currentIsNew) {
      await fs.mkdir(path.join(newRelease, "apps", "dashboard"), { recursive: true });
      await fs.writeFile(path.join(newRelease, "apps", "dashboard", "server.mjs"), "// current release\n");
      await fs.writeFile(path.join(newRelease, "apps", "dashboard", "worker.mjs"), "// current worker\n");
      await fs.mkdir(path.join(newRelease, "deploy"), { recursive: true });
      await fs.writeFile(path.join(newRelease, "deploy", "ecosystem.config.cjs"), "module.exports = { apps: [] };\n");
      await fs.writeFile(path.join(newRelease, ".release-ready"), "ready\n");
    }
    await switchLink(currentLink, options.currentIsNew ? newRelease : oldRelease);
    await switchLink(previousLink, oldRelease);
  }

  const env = {
    SOURCE_DIR: toBashPath(repoRoot),
    PROD_DIR: toBashPath(prodDir),
    RELEASE_ID: releaseId,
    KEEP_RELEASES: "3",
    BACKUP_DIR: toBashPath(backupDir),
    BACKUP_RETENTION_DAYS: "14",
    ACCEPTANCE_ATTEMPTS: "1",
    ACCEPTANCE_DELAY_SECONDS: "0",
    OPS_TEST_BIN: toBashPath(fakeBin),
    OPS_TEST_LOG: toBashPath(logPath),
    DATABASE_URL: "postgresql://ops:secret@127.0.0.1:5432/ops_test",
    RESTORE_DATABASE_URL: "postgresql://ops:secret@127.0.0.1:5432/ops_test",
    RESTORE_CONFIRM_DATABASE: "ops_test",
    ALLOW_DIRTY_SOURCE: "YES",
    PM2_STABILITY_ATTEMPTS: "1",
    PM2_STABILITY_DELAY_SECONDS: "0",
    PM2_MIN_UPTIME_MS: "10000"
  };
  return { root, prodDir, oldRelease: toBashPath(oldRelease), newRelease: toBashPath(newRelease), currentLink, previousLink, fakeBin, logPath, backupDir, env };
}

async function installFakeCommands(fakeBin) {
  const scripts = {
    rsync: `#!/usr/bin/env bash
set -euo pipefail
echo "rsync $*" >> "$OPS_TEST_LOG"
args=("$@")
src="\${args[\${#args[@]}-2]}"
dest="\${args[\${#args[@]}-1]}"
mkdir -p "$dest"
cp -a "\${src%/}/." "$dest/"
`,
    npm: `#!/usr/bin/env bash
set -euo pipefail
echo "npm $*" >> "$OPS_TEST_LOG"
if [[ "\${OPS_TEST_FAIL_STEP:-}" == "install" && "$*" == *"ci"* ]]; then exit 41; fi
if [[ "\${OPS_TEST_FAIL_STEP:-}" == "migrate" && "$*" == *"run migrate"* ]]; then exit 42; fi
`,
    pm2: `#!/usr/bin/env bash
set -euo pipefail
echo "pm2 $*" >> "$OPS_TEST_LOG"
if [[ "\${1:-}" == "describe" ]]; then exit 0; fi
if [[ "\${1:-}" == "jlist" ]]; then
  status=online
  [[ "\${OPS_TEST_PM2_UNSTABLE:-}" == "1" ]] && status=stopped
  now_ms="$(date +%s)000"
  uptime="$((now_ms - 20000))"
  printf '[{"name":"ai-product-reliability-kit","pm2_env":{"status":"online","pm_uptime":%s}},{"name":"ai-product-reliability-worker","pm2_env":{"status":"%s","pm_uptime":%s}}]\n' "$uptime" "$status" "$uptime"
  exit 0
fi
if [[ "\${OPS_TEST_FAIL_SAVE_ONCE:-}" == "1" && "\${1:-}" == "save" && ! -f "$OPS_TEST_LOG.save-failed" ]]; then
  : > "$OPS_TEST_LOG.save-failed"
  exit 44
fi
if [[ "\${OPS_TEST_FAIL_RELOAD_ONCE:-}" == "1" && "\${1:-}" == "reload" && ! -f "$OPS_TEST_LOG.reload-failed" ]]; then
  : > "$OPS_TEST_LOG.reload-failed"
  exit 43
fi
`,
    curl: `#!/usr/bin/env bash
set -euo pipefail
echo "curl $*" >> "$OPS_TEST_LOG"
if [[ "\${OPS_TEST_FAIL_ACCEPTANCE:-}" == "1" ]]; then exit 22; fi
printf '{"ok":true}\n'
`,
    pg_dump: `#!/usr/bin/env bash
set -euo pipefail
echo "pg_dump $*" >> "$OPS_TEST_LOG"
out=""
while (( $# )); do
  case "$1" in
    --file) out="$2"; shift 2 ;;
    --file=*) out="\${1#--file=}"; shift ;;
    *) shift ;;
  esac
done
[[ -n "$out" ]]
printf 'fake postgres custom archive\n' > "$out"
`,
    pg_restore: `#!/usr/bin/env bash
set -euo pipefail
echo "pg_restore $*" >> "$OPS_TEST_LOG"
if [[ " $* " == *" --list "* ]]; then printf '1; 0 0 TABLE public products ops\n'; fi
`,
    psql: `#!/usr/bin/env bash
set -euo pipefail
echo "psql $*" >> "$OPS_TEST_LOG"
if [[ "$*" == *"current_database"* ]]; then
  database="$PGDATABASE"
  database="\${database%%[?]*}"
  database="\${database%/}"
  printf '%s\n' "\${database##*/}"
else
  printf '1\n'
fi
`,
    createdb: `#!/usr/bin/env bash
set -euo pipefail
echo "createdb $*" >> "$OPS_TEST_LOG"
`,
    dropdb: `#!/usr/bin/env bash
set -euo pipefail
echo "dropdb $*" >> "$OPS_TEST_LOG"
`
  };
  for (const [name, content] of Object.entries(scripts)) {
    const target = path.join(fakeBin, name);
    await fs.writeFile(target, content, { mode: 0o755 });
    await fs.chmod(target, 0o755);
  }
}

function runRepoScript(relativePath, env) {
  if (!bash) return { status: 127, stdout: "", stderr: "Bash not found" };
  const script = toBashPath(path.join(repoRoot, relativePath));
  return spawnSync(bash, ["-c", 'export PATH="$OPS_TEST_BIN:$PATH"; exec bash "$OPS_SCRIPT"'], {
    cwd: repoRoot,
    env: { ...process.env, ...env, OPS_SCRIPT: script },
    encoding: "utf8"
  });
}

async function switchLink(link, target, options = {}) {
  if (options.createTarget) await fs.mkdir(target, { recursive: true });
  const linkPath = toBashPath(link);
  const targetPath = toBashPath(target);
  const result = spawnSync(bash, ["-c", 'mkdir -p "$(dirname "$LINK_PATH")"; rm -f "$LINK_PATH"; ln -s "$TARGET_PATH" "$LINK_PATH"'], {
    env: { ...process.env, LINK_PATH: linkPath, TARGET_PATH: targetPath },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
}

function resolveLink(link) {
  const linkPath = toBashPath(link);
  return execFileSync(bash, ["-c", 'readlink -f "$LINK_PATH"'], {
    env: { ...process.env, LINK_PATH: linkPath },
    encoding: "utf8"
  }).trim();
}

function toBashPath(value) {
  if (process.platform !== "win32") return value;
  return execFileSync(bash, ["-c", 'cygpath -u "$INPUT_PATH"'], {
    env: { ...process.env, INPUT_PATH: value },
    encoding: "utf8"
  }).trim();
}

function findBash() {
  const candidates = [
    process.env.BASH_BIN,
    process.platform === "win32" ? "D:\\Software\\Git\\bin\\bash.exe" : "bash",
    process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : null,
    "bash"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (result.status === 0) return candidate;
  }
  return null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
