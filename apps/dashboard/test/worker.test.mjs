import assert from "node:assert/strict";
import test from "node:test";
import { startWorker } from "../worker.mjs";
import { MemoryStore } from "../src/stores/memory-store.mjs";

test("two workers share one scheduler lease and stop gracefully", async () => {
  const store = new MemoryStore();
  await store.ready();
  let schedulerRuns = 0;
  let retentionRuns = 0;
  store.runRetention = async () => { retentionRuns += 1; return { deleted: {} }; };

  const options = {
    runScheduler: async () => { schedulerRuns += 1; await new Promise((resolve) => setTimeout(resolve, 30)); },
    intervalMs: 60_000,
    runImmediately: true,
    runRetentionImmediately: true
  };
  const first = startWorker(store, { rawRetentionDays: 30 }, options);
  const second = startWorker(store, { rawRetentionDays: 30 }, options);
  await Promise.all([first.ready, second.ready]);
  await Promise.all([first.stop(), second.stop()]);

  assert.equal(schedulerRuns, 1);
  assert.equal(retentionRuns, 1);
  assert.equal(first.running, false);
  assert.equal(second.running, false);
});

test("periodic scheduler failures are contained and later ticks continue", async () => {
  const store = new MemoryStore();
  await store.ready();
  const errors = [];
  let schedulerRuns = 0;
  const worker = startWorker(store, {}, {
    intervalMs: 5,
    runImmediately: false,
    runScheduler: async () => {
      schedulerRuns += 1;
      if (schedulerRuns === 1) throw new Error("transient scheduler failure");
    },
    onError: (error) => errors.push(error.message)
  });

  await waitFor(() => schedulerRuns >= 2);
  await worker.stop();

  assert.deepEqual(errors, ["transient scheduler failure"]);
  assert.equal(schedulerRuns >= 2, true);
  assert.equal(worker.running, false);
});

test("initial worker readiness still rejects an explicit startup failure", async () => {
  const store = new MemoryStore();
  await store.ready();
  const worker = startWorker(store, {}, {
    intervalMs: 60_000,
    runImmediately: true,
    runScheduler: async () => { throw new Error("startup scheduler failure"); }
  });

  await assert.rejects(worker.ready, /startup scheduler failure/);
  await worker.stop();
});

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for worker tick");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
