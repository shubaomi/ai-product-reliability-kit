import net from "node:net";

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const sessionSecret = env.APR_SESSION_SECRET ?? env.APR_MASTER_API_KEY ?? "development-session-secret";
  return {
    nodeEnv,
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    publicBaseUrl: env.PUBLIC_BASE_URL ?? "http://127.0.0.1:8787",
    databaseUrl: env.DATABASE_URL,
    storeMode: env.APR_STORE_MODE ?? (env.DATABASE_URL ? "postgres" : "json"),
    dashboardStore: env.APR_DASHBOARD_STORE,
    authRequired: parseBool(env.APR_AUTH_REQUIRED, nodeEnv === "production"),
    adminEmail: env.APR_ADMIN_EMAIL ?? "admin@example.com",
    adminPasswordHash: env.APR_ADMIN_PASSWORD_HASH,
    masterApiKey: env.APR_MASTER_API_KEY,
    ingestApiKey: env.APR_INGEST_API_KEY,
    sessionSecret,
    userIdHmacSecret: env.APR_USER_ID_HMAC_SECRET ?? sessionSecret,
    corsOrigins: parseList(env.APR_CORS_ORIGINS),
    trustedProxyIps: parseList(env.APR_TRUSTED_PROXIES),
    allowedMonitorHosts: parseList(env.APR_MONITOR_HOST_ALLOWLIST).map((value) => value.toLowerCase()),
    allowedEnvironments: parseList(env.APR_ALLOWED_ENVIRONMENTS ?? "production,staging,development,local,test"),
    maxBodyBytes: Number(env.APR_MAX_BODY_BYTES ?? 512 * 1024),
    maxBatchSize: Number(env.APR_MAX_BATCH_SIZE ?? 500),
    maxStringLength: Number(env.APR_MAX_STRING_LENGTH ?? 4096),
    maxProductIdLength: Number(env.APR_MAX_PRODUCT_ID_LENGTH ?? 128),
    maxClockSkewMs: Number(env.APR_MAX_CLOCK_SKEW_SECONDS ?? 300) * 1000,
    maxPastEventAgeMs: Number(env.APR_MAX_PAST_EVENT_AGE_SECONDS ?? 7 * 24 * 60 * 60) * 1000,
    rateLimitWindowMs: Number(env.APR_RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMax: Number(env.APR_RATE_LIMIT_MAX ?? 600),
    loginRateLimitMax: Number(env.APR_LOGIN_RATE_LIMIT_MAX ?? 20),
    ingestRateLimitMax: Number(env.APR_INGEST_RATE_LIMIT_MAX ?? 600),
    workerEnabled: parseBool(env.APR_WORKER_ENABLED, false),
    processRole: env.APR_PROCESS_ROLE ?? (nodeEnv === "production" ? "api" : "all"),
    workerIntervalMs: Number(env.APR_WORKER_INTERVAL_MS ?? 60_000),
    retentionIntervalMs: Number(env.APR_RETENTION_INTERVAL_MS ?? 24 * 60 * 60_000),
    rawRetentionDays: Number(env.APR_RAW_RETENTION_DAYS ?? 30),
    telemetryStaleAfterMs: Number(env.APR_TELEMETRY_STALE_SECONDS ?? 300) * 1000,
    gracefulShutdownMs: Number(env.APR_GRACEFUL_SHUTDOWN_MS ?? 30_000),
    alertWebhookUrl: env.APR_ALERT_WEBHOOK_URL,
    alertFeishuWebhookUrl: env.APR_ALERT_FEISHU_WEBHOOK_URL,
    incidentLookbackHours: Number(env.APR_INCIDENT_LOOKBACK_HOURS ?? 24)
  };
}

export function validateConfig(config) {
  for (const [name, value] of [
    ["port", config.port],
    ["maxBodyBytes", config.maxBodyBytes],
    ["maxBatchSize", config.maxBatchSize],
    ["maxStringLength", config.maxStringLength],
    ["maxProductIdLength", config.maxProductIdLength],
    ["maxClockSkewMs", config.maxClockSkewMs],
    ["maxPastEventAgeMs", config.maxPastEventAgeMs],
    ["rateLimitWindowMs", config.rateLimitWindowMs],
    ["rateLimitMax", config.rateLimitMax],
    ["loginRateLimitMax", config.loginRateLimitMax],
    ["ingestRateLimitMax", config.ingestRateLimitMax],
    ["workerIntervalMs", config.workerIntervalMs],
    ["retentionIntervalMs", config.retentionIntervalMs],
    ["rawRetentionDays", config.rawRetentionDays],
    ["telemetryStaleAfterMs", config.telemetryStaleAfterMs],
    ["gracefulShutdownMs", config.gracefulShutdownMs]
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }

  for (const ip of config.trustedProxyIps ?? []) {
    if (!net.isIP(normalizeIp(ip))) throw new Error(`APR_TRUSTED_PROXIES contains an invalid IP: ${ip}`);
  }

  validateOptionalHttpUrl("APR_ALERT_WEBHOOK_URL", config.alertWebhookUrl, config.nodeEnv === "production");
  validateOptionalHttpUrl("APR_ALERT_FEISHU_WEBHOOK_URL", config.alertFeishuWebhookUrl, config.nodeEnv === "production");
  if (!["api", "worker", "all"].includes(config.processRole)) {
    throw new Error("APR_PROCESS_ROLE must be api, worker, or all");
  }

  if (config.nodeEnv !== "production") return config;

  if (config.host !== "127.0.0.1" || config.port !== 8787) {
    throw new Error("Production must bind to 127.0.0.1:8787 behind Nginx");
  }
  if (config.storeMode !== "postgres") throw new Error("Production requires APR_STORE_MODE=postgres");
  validateDatabaseUrl(config.databaseUrl);
  validateHttpsUrl("PUBLIC_BASE_URL", config.publicBaseUrl);
  if (!config.authRequired) throw new Error("Production requires APR_AUTH_REQUIRED=true");
  if (!isEmail(config.adminEmail) || /@example\.com$/i.test(config.adminEmail)) {
    throw new Error("Production requires a non-placeholder APR_ADMIN_EMAIL");
  }
  requireSafeSecret("APR_ADMIN_PASSWORD_HASH", config.adminPasswordHash, 16);
  validatePasswordHash(config.adminPasswordHash);
  requireSafeSecret("APR_MASTER_API_KEY", config.masterApiKey, 32);
  requireSafeSecret("APR_INGEST_API_KEY", config.ingestApiKey, 32);
  requireSafeSecret("APR_SESSION_SECRET", config.sessionSecret, 32);
  requireSafeSecret("APR_USER_ID_HMAC_SECRET", config.userIdHmacSecret, 32);
  const independentSecrets = [config.masterApiKey, config.ingestApiKey, config.sessionSecret, config.userIdHmacSecret];
  if (new Set(independentSecrets).size !== independentSecrets.length) {
    throw new Error("Production API keys, session secret, and identifier HMAC secret must be distinct");
  }
  if (!(config.trustedProxyIps?.length)) {
    throw new Error("Production requires APR_TRUSTED_PROXIES to define the reverse proxy boundary");
  }
  return config;
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseList(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function requireSafeSecret(name, value, minLength) {
  if (!value || String(value).length < minLength) throw new Error(`${name} must be at least ${minLength} characters`);
  if (/(replace[-_ ]?with|change[-_ ]?me|development|example|default|placeholder)/i.test(String(value))) {
    throw new Error(`${name} contains an unsafe placeholder value`);
  }
}

function validateDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
  }
  if (!parsed.username || !parsed.password) throw new Error("DATABASE_URL must include non-empty credentials");
}

function validateHttpsUrl(name, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error(`${name} must use https`);
}

function validateOptionalHttpUrl(name, value, requireHttps) {
  if (!value) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name} must use http or https`);
  if (requireHttps && parsed.protocol !== "https:") throw new Error(`${name} must use https in production`);
}

function validatePasswordHash(value) {
  const match = /^pbkdf2_sha256\$(\d+)\$([^$]{16,})\$([a-f0-9]{64})$/i.exec(String(value ?? ""));
  if (!match || Number(match[1]) < 210_000) {
    throw new Error("APR_ADMIN_PASSWORD_HASH must be a PBKDF2-SHA256 hash with at least 210000 iterations");
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value ?? ""));
}

function normalizeIp(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("::ffff:") ? text.slice(7) : text;
}
