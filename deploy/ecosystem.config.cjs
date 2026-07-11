"use strict";

const currentLink = process.env.APR_CURRENT_LINK || "/data/prod/ai-product-reliability-kit/current";
const apiName = process.env.APR_API_APP_NAME || "ai-product-reliability-kit";
const workerName = process.env.APR_WORKER_APP_NAME || "ai-product-reliability-worker";
const dashboardDirectory = `${currentLink}/apps/dashboard`;

const shared = {
  cwd: dashboardDirectory,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  restart_delay: 2_000,
  max_restarts: 10,
  min_uptime: "10s",
  kill_timeout: 35_000,
  max_memory_restart: "512M",
  time: true
};

module.exports = {
  apps: [
    {
      ...shared,
      name: apiName,
      script: `${dashboardDirectory}/server.mjs`,
      env_production: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8787",
        APR_PROCESS_ROLE: "api",
        APR_WORKER_ENABLED: "false"
      }
    },
    {
      ...shared,
      name: workerName,
      script: `${dashboardDirectory}/worker.mjs`,
      env_production: {
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: "8787",
        APR_PROCESS_ROLE: "worker",
        APR_WORKER_ENABLED: "true"
      }
    }
  ]
};
