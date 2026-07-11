import crypto from "node:crypto";

const SESSION_COOKIE = "apr_session";

export function createSecurity(config) {
  const rateStates = new Map([
    ["login", new Map()],
    ["ingest", new Map()],
    ["general", new Map()]
  ]);

  return {
    SESSION_COOKIE,
    securityHeaders: buildSecurityHeaders(config),

    isPublicRoute(method, pathname) {
      if (method === "GET" && (pathname === "/" || pathname.startsWith("/status") || pathname.startsWith("/public/"))) return true;
      if (method === "GET" && ["/styles.css", "/app.js"].includes(pathname)) return true;
      if (method === "POST" && pathname === "/api/session/login") return true;
      if (method === "GET" && pathname === "/api/status") return true;
      if (method === "GET" && ["/healthz", "/readyz"].includes(pathname)) return true;
      return false;
    },

    checkRateLimit(request, url) {
      const bucketName = rateBucket(request.method, url?.pathname ?? request.url ?? "/");
      const rateState = rateStates.get(bucketName);
      const ip = clientIp(request, config);
      const now = Date.now();
      const bucket = rateState.get(ip) ?? { start: now, count: 0 };
      if (now - bucket.start > config.rateLimitWindowMs) {
        bucket.start = now;
        bucket.count = 0;
      }
      bucket.count += 1;
      rateState.set(ip, bucket);
      if (rateState.size > 10_000) cleanupExpired(rateState, now, config.rateLimitWindowMs);
      const limit = bucketName === "login"
        ? config.loginRateLimitMax
        : bucketName === "ingest"
          ? config.ingestRateLimitMax
          : config.rateLimitMax;
      return {
        ok: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        bucket: bucketName,
        clientIp: ip
      };
    },

    async authenticate(request, url, store) {
      if (!config.authRequired || this.isPublicRoute(request.method, url.pathname)) {
        return { ok: true, principal: { type: "anonymous", scopes: ["*"] } };
      }

      const bearer = bearerToken(request);
      if (bearer) {
        if (config.masterApiKey && timingSafeEqual(bearer, config.masterApiKey)) {
          return { ok: true, principal: { type: "master", scopes: ["admin", "ingest", "read"] } };
        }
        if (config.ingestApiKey && timingSafeEqual(bearer, config.ingestApiKey)) {
          return { ok: true, principal: { type: "ingest", scopes: ["ingest"] } };
        }
        const keyRecord = await store.findApiKey?.(hashSecret(bearer));
        if (keyRecord) {
          await store.markApiKeyUsed?.(keyRecord.id);
          return { ok: true, principal: { type: "project-key", product_id: keyRecord.product_id, scopes: keyRecord.scopes ?? ["ingest"] } };
        }
      }

      const session = parseCookie(request.headers.cookie ?? "")[SESSION_COOKIE];
      if (session && verifySession(session, config.sessionSecret)) {
        return { ok: true, principal: { type: "session", scopes: ["admin", "read", "ingest"] } };
      }

      return { ok: false, status: 401, error: "Authentication required" };
    },

    authorize(principal, scope) {
      if (!principal) return false;
      if (principal.scopes?.includes("*")) return true;
      if (principal.scopes?.includes("admin")) return true;
      return principal.scopes?.includes(scope);
    },

    async login(body) {
      const email = String(body.email ?? "");
      const password = String(body.password ?? "");
      if (email !== config.adminEmail) return null;
      if (config.adminPasswordHash) {
        if (!verifyPassword(password, config.adminPasswordHash)) return null;
      } else if (!config.masterApiKey || !timingSafeEqual(password, config.masterApiKey)) {
        return null;
      }
      return createSession({ email, role: "admin" }, config.sessionSecret);
    }
  };
}

export function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function createApiKeySecret() {
  return `apr_pk_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 210_000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$210000$${salt}$${hash}`;
}

export function verifyPassword(password, encoded) {
  const [algo, iterations, salt, expected] = String(encoded).split("$");
  if (algo !== "pbkdf2_sha256" || !iterations || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(password, salt, Number(iterations), 32, "sha256").toString("hex");
  return timingSafeEqual(actual, expected);
}

function createSession(payload, secret) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 8 * 60 * 60 * 1000 })).toString("base64url");
  const sig = hmac(data, secret);
  return `${data}.${sig}`;
}

function verifySession(token, secret) {
  const [data, sig] = String(token).split(".");
  if (!data || !sig || !timingSafeEqual(sig, hmac(data, secret))) return false;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return payload.exp > Date.now();
  } catch {
    return false;
  }
}

function hmac(data, secret) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function bearerToken(request) {
  const auth = request.headers.authorization ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return request.headers["x-apr-api-key"];
}

function parseCookie(header) {
  return Object.fromEntries(
    header.split(";").map((part) => part.trim().split("=")).filter((parts) => parts.length === 2)
  );
}

export function clientIp(request, config = {}) {
  const remoteAddress = normalizeIp(request.socket?.remoteAddress ?? "unknown");
  const trusted = new Set((config.trustedProxyIps ?? []).map(normalizeIp));
  if (!trusted.has(remoteAddress)) return remoteAddress;
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => normalizeIp(value.trim()))
    .filter(Boolean);
  let current = remoteAddress;
  for (let index = forwarded.length - 1; index >= 0 && trusted.has(current); index -= 1) {
    current = forwarded[index];
  }
  return current;
}

function buildSecurityHeaders(config) {
  const connectSrc = ["'self'", ...config.corsOrigins].join(" ");
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "content-security-policy": [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      `connect-src ${connectSrc}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join("; ")
  };
}

function rateBucket(method, pathname) {
  if (method === "POST" && pathname === "/api/session/login") return "login";
  if (method === "POST" && ["/api/ingest", "/api/compliance-scans"].includes(pathname)) return "ingest";
  return "general";
}

function cleanupExpired(state, now, windowMs) {
  for (const [key, bucket] of state) {
    if (now - bucket.start > windowMs) state.delete(key);
  }
}

function normalizeIp(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("::ffff:") ? text.slice(7) : text;
}
