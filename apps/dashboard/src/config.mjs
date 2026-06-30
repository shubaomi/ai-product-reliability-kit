export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
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
    sessionSecret: env.APR_SESSION_SECRET ?? env.APR_MASTER_API_KEY ?? "development-session-secret",
    corsOrigins: parseList(env.APR_CORS_ORIGINS),
    maxBodyBytes: Number(env.APR_MAX_BODY_BYTES ?? 512 * 1024),
    maxBatchSize: Number(env.APR_MAX_BATCH_SIZE ?? 500),
    rateLimitWindowMs: Number(env.APR_RATE_LIMIT_WINDOW_MS ?? 60_000),
    rateLimitMax: Number(env.APR_RATE_LIMIT_MAX ?? 600),
    workerEnabled: parseBool(env.APR_WORKER_ENABLED, false),
    workerIntervalMs: Number(env.APR_WORKER_INTERVAL_MS ?? 60_000),
    alertWebhookUrl: env.APR_ALERT_WEBHOOK_URL,
    alertFeishuWebhookUrl: env.APR_ALERT_FEISHU_WEBHOOK_URL,
    incidentLookbackHours: Number(env.APR_INCIDENT_LOOKBACK_HOURS ?? 24)
  };
}

function parseBool(value, fallback) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function parseList(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

