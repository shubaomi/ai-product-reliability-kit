export function createReliabilityClient(options) {
  const required = ["productId", "environment", "release"];
  for (const key of required) {
    if (!options?.[key]) {
      throw new Error(`Missing required option: ${key}`);
    }
  }

  const endpoint = trimTrailingSlash(options.endpoint ?? "http://127.0.0.1:8787");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required");
  }

  const queue = [];
  const base = {
    schema_version: "1.0",
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
      payload
    };
  }

  function enqueue(type, payload, context) {
    const item = envelope(type, payload, context);
    queue.push(item);
    return item;
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

    async flush() {
      if (!queue.length) return { sent: 0 };
      const batch = queue.splice(0, queue.length);
      const response = await fetchImpl(`${endpoint}/api/ingest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {})
        },
        body: JSON.stringify({ items: batch })
      });

      if (!response.ok) {
        queue.unshift(...batch);
        throw new Error(`Reliability ingest failed: ${response.status}`);
      }

      return response.json().catch(() => ({ sent: batch.length }));
    }
  };
}

export function healthPayload(checks = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(checks)) {
    normalized[name] = Boolean(value);
  }
  return {
    ok: Object.values(normalized).every(Boolean),
    checks: normalized
  };
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

  return {
    name: "Error",
    message: String(error),
    properties: context.properties ?? {}
  };
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

