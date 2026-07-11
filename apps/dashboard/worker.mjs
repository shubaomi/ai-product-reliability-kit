#!/usr/bin/env node
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig, validateConfig } from "./src/config.mjs";
import { runSchedulerOnce } from "./src/scheduler.mjs";
import { createStore } from "./src/stores/index.mjs";

export function startWorker(store, config = {}, options = {}) {
  const intervalMs = options.intervalMs ?? config.workerIntervalMs ?? 60_000;
  const retentionIntervalMs = options.retentionIntervalMs ?? config.retentionIntervalMs ?? 24 * 60 * 60_000;
  const runScheduler = options.runScheduler ?? ((targetStore) => runSchedulerOnce(targetStore, config, options));
  let stopped = false;
  let running = false;
  let active = null;
  let lastRetentionAt = null;
  const reportError = options.onError ?? ((error) => console.error("Worker scheduler failed", error));

  const tick = () => {
    if (stopped || active) return active ?? Promise.resolve({ acquired: false });
    running = true;
    active = store.withSchedulerLease(async () => {
      await runScheduler(store);
      const now = Date.now();
      const retentionDue = options.runRetentionImmediately === true
        || lastRetentionAt == null
        || now - lastRetentionAt >= retentionIntervalMs;
      if (retentionDue && store.runRetention) {
        await store.runRetention({ rawRetentionDays: config.rawRetentionDays ?? 30 }, new Date(now));
        lastRetentionAt = now;
      }
    }).finally(() => {
      running = false;
      active = null;
    });
    return active;
  };

  const timer = setInterval(() => void tick().catch(reportError), intervalMs);
  const ready = options.runImmediately === false ? Promise.resolve() : tick();
  return {
    ready,
    get running() { return running; },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await active;
      running = false;
      await store.close?.();
    }
  };
}

async function main() {
  const config = validateConfig(loadConfig());
  const store = await createStore(config);
  const worker = startWorker(store, config, { runImmediately: true });
  await worker.ready;
  console.log("AI Product Reliability Worker started");
  const shutdown = async (signal) => {
    console.log(`AI Product Reliability Worker received ${signal}`);
    await worker.stop();
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
