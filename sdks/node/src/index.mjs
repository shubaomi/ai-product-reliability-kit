import { randomUUID } from "node:crypto";

export function createReliabilityClient(options) {
  for (const key of ["productId", "environment", "release"]) {
    if (!options?.[key]) throw new Error(`Missing required option: ${key}`);
  }

  const schemaVersion = options.schemaVersion ?? "1.0";
  if (!/^1\.\d+$/.test(schemaVersion)) throw new Error(`Unsupported schema version: ${schemaVersion}`);
  const endpoint = trimTrailingSlash(options.endpoint ?? "http://127.0.0.1:8787");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  const maxQueueSize = positiveInteger(options.maxQueueSize ?? 1000, "maxQueueSize");
  const maxRetries = nonNegativeInteger(options.maxRetries ?? 3, "maxRetries");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 2000, "timeoutMs");
  const baseDelayMs = nonNegativeNumber(options.baseDelayMs ?? 100, "baseDelayMs");
  const maxDelayMs = positiveInteger(options.maxDelayMs ?? 5000, "maxDelayMs");
  const jitterRatio = boundedNumber(options.jitterRatio ?? 0.2, 0, 1, "jitterRatio");
  const failOpen = options.failOpen !== false;
  const sleepImpl = options.sleepImpl ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const randomImpl = options.randomImpl ?? Math.random;
  const idFactory = options.idFactory ?? randomUUID;
  const queue = [];
  let droppedCount = 0;
  let closed = false;
  let flushPromise = null;
  let activeController = null;
  let closeDeadlineMs = Number.POSITIVE_INFINITY;
  const closeDeadlineController = new AbortController();

  const base = {
    schema_version: schemaVersion,
    product_id: options.productId,
    environment: options.environment,
    release: options.release
  };

  function envelope(type, payload, context = {}) {
    return {
      ...base,
      type,
      occurred_at: context.occurredAt ?? new Date().toISOString(),
      anonymous_id: context.anonymousId,
      user_id: context.userId,
      request_id: context.requestId,
      idempotency_key: context.idempotencyKey ?? idFactory(),
      payload
    };
  }

  function enqueue(type, payload, context) {
    if (closed) {
      droppedCount += 1;
      return null;
    }
    const item = envelope(type, payload, context);
    if (queue.length >= maxQueueSize) {
      queue.shift();
      droppedCount += 1;
    }
    queue.push(item);
    return item;
  }

  async function flush(flushOptions = {}) {
    if (flushPromise) return flushPromise;
    flushPromise = doFlush(flushOptions).finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  async function doFlush(flushOptions) {
    if (!queue.length) return { sent: 0, failed: 0, attempts: 0 };
    const batch = queue.splice(0, queue.length);
    const body = JSON.stringify({ items: batch });
    const requestedDeadlineMs = flushOptions.deadlineMs ?? Number.POSITIVE_INFINITY;
    let lastError;
    let timedOut = false;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const deadlineMs = Math.min(requestedDeadlineMs, closeDeadlineMs);
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        lastError = new Error("Reliability close deadline exceeded");
        break;
      }
      attempts += 1;
      const controller = new AbortController();
      activeController = controller;
      const requestTimeout = Math.max(1, Math.min(timeoutMs, remaining));
      const timer = setTimeout(() => controller.abort(new Error("Reliability ingest timed out")), requestTimeout);
      let retryable = true;
      try {
        const response = await fetchImpl(`${endpoint}/api/ingest`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
          },
          body,
          signal: controller.signal
        });
        if (!response.ok) {
          const error = new Error(`Reliability ingest failed: ${response.status}`);
          error.status = response.status;
          error.retryable = isRetryableHttpStatus(response.status);
          throw error;
        }
        const payload = await response.json().catch(() => ({}));
        return { sent: batch.length, failed: 0, attempts, ...payload };
      } catch (error) {
        lastError = error;
        timedOut ||= controller.signal.aborted;
        retryable = error?.retryable !== false;
      } finally {
        if (activeController === controller) activeController = null;
        clearTimeout(timer);
      }

      if (!retryable) break;
      if (attempt < maxRetries) {
        const delay = retryDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, randomImpl);
        const deadlineMs = Math.min(requestedDeadlineMs, closeDeadlineMs);
        if (Date.now() + delay >= deadlineMs) {
          timedOut = true;
          break;
        }
        if (!(await waitForRetryDelay(delay))) {
          timedOut = true;
          lastError ??= new Error("Reliability close deadline exceeded");
          break;
        }
      }
    }

    requeue(batch);
    const result = {
      sent: 0,
      failed: batch.length,
      attempts,
      timed_out: timedOut,
      error: lastError?.message ?? "Reliability ingest failed"
    };
    if (failOpen) return result;
    const error = lastError ?? new Error(result.error);
    error.result = result;
    throw error;
  }

  function requeue(batch) {
    const combined = [...batch, ...queue];
    if (combined.length > maxQueueSize) {
      droppedCount += combined.length - maxQueueSize;
      combined.length = maxQueueSize;
    }
    queue.splice(0, queue.length, ...combined);
  }

  async function waitForRetryDelay(delay) {
    const { signal } = closeDeadlineController;
    if (signal.aborted) return false;
    let onAbort;
    const aborted = new Promise((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        Promise.resolve(sleepImpl(delay, signal)).then(() => true),
        aborted
      ]);
    } catch (error) {
      if (signal.aborted) return false;
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async function close(closeOptions = {}) {
    closed = true;
    const closeTimeoutMs = positiveInteger(closeOptions.timeoutMs ?? options.closeTimeoutMs ?? 5000, "close timeout");
    const deadlineMs = Date.now() + closeTimeoutMs;
    closeDeadlineMs = Math.min(closeDeadlineMs, deadlineMs);
    const deadlineTimer = setTimeout(() => {
      activeController?.abort(new Error("Reliability close deadline exceeded"));
      closeDeadlineController.abort(new Error("Reliability close deadline exceeded"));
    }, closeTimeoutMs);
    let result = { sent: 0, failed: 0, attempts: 0 };

    try {
      while (flushPromise || queue.length) {
        const current = await flush({ deadlineMs });
        result = mergeFlushResults(result, current);
        if (current.failed > 0 || current.timed_out || Date.now() >= deadlineMs) break;
      }
      if (queue.length && Date.now() >= deadlineMs) {
        result.timed_out = true;
        result.error ??= "Reliability close deadline exceeded";
      }
      return result;
    } finally {
      clearTimeout(deadlineTimer);
      if (closeDeadlineMs === deadlineMs) closeDeadlineMs = Number.POSITIVE_INFINITY;
    }
  }

  return {
    event(name, properties = {}, context = {}) {
      return enqueue("event", { event: name, properties }, context);
    },
    error(error, context = {}) {
      return enqueue("error", normalizeError(error, context), context);
    },
    health(checks = {}, context = {}) {
      return enqueue("health", healthPayload(checks), context);
    },
    release(version, properties = {}, context = {}) {
      return enqueue("release", { version, properties }, context);
    },
    product(contract, context = {}) {
      return enqueue("product", { contract }, context);
    },
    queued() {
      return queue.slice();
    },
    dropped() {
      return droppedCount;
    },
    stats() {
      return { queued: queue.length, dropped: droppedCount, closed };
    },
    flush,
    close
  };
}

export function healthPayload(checks = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(checks)) normalized[name] = Boolean(value);
  return { ok: Object.values(normalized).every(Boolean), checks: normalized };
}

function normalizeError(error, context) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: context.includeStack ? error.stack : undefined,
      properties: context.properties ?? {}
    };
  }
  return { name: "Error", message: String(error), properties: context.properties ?? {} };
}

function retryDelay(attempt, baseDelayMs, maxDelayMs, jitterRatio, randomImpl) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
  const jitter = 1 + (((randomImpl() * 2) - 1) * jitterRatio);
  return Math.max(0, Math.round(exponential * jitter));
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

function mergeFlushResults(total, current) {
  const merged = {
    ...current,
    sent: total.sent + current.sent,
    failed: total.failed + current.failed,
    attempts: total.attempts + current.attempts
  };
  if (Number.isFinite(total.accepted) || Number.isFinite(current.accepted)) {
    merged.accepted = (total.accepted ?? 0) + (current.accepted ?? 0);
  }
  if (total.timed_out || current.timed_out) merged.timed_out = true;
  if (total.error && !merged.error) merged.error = total.error;
  return merged;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== "number" || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function boundedNumber(value, min, max, name) {
  if (typeof value !== "number" || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
