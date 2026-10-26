import { isIP } from "node:net";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { config_ } from "../env.js";
import { apiError } from "./errors.js";
import { clock } from "../services/clock.js";

export interface Bucket {
  count: number;
  resetAt: number;
}

// Storage seam. The default is a per-process Map (single box: counters reset
// on restart). A shared store (e.g. Redis INCR + PEXPIRE) can implement this
// interface and be passed to createRateLimiter({ store }) without touching
// any call site.
export interface RateStore {
  /** Count one hit against `key`, opening a new window when none is live. */
  hit(key: string, windowMs: number, now: number): Promise<Bucket>;
  /** Read the live bucket without counting. */
  peek(key: string, now: number): Promise<Bucket | undefined>;
}

export class MemoryRateStore implements RateStore {
  readonly buckets = new Map<string, Bucket>();

  async hit(key: string, windowMs: number, now: number): Promise<Bucket> {
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    // lazy sweep so the map can't grow without bound
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
    }
    return bucket;
  }

  async peek(key: string, now: number): Promise<Bucket | undefined> {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > now ? bucket : undefined;
  }
}

const WINDOW_MS = 60_000;

/**
 * Real client address. Forwarding headers are caller-controlled, so they are
 * only honored when the deploy declares a trusted proxy (TRUSTED_PROXY=1):
 * CF-Connecting-IP first (Cloudflare sets it and strips client copies), then
 * X-Forwarded-For — the LAST hop, which is the one our own proxy appended
 * (the first entries are client-supplied and spoofable).
 */
export function clientIp(c: Context): string {
  if (!config_.trustedProxy) return "local";
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf && isIP(cf)) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && isIP(last)) return last;
  }
  return "local";
}

// Identity is set by requireSession upstream (session user / agent key / PAT /
// JWT). Falls back to client IP for unauthenticated requests.
function identityKey(c: Context): string {
  const agent = c.get("agentAuth");
  if (agent) return `agent:${agent.keyId}`;
  const session = c.get("session");
  if (session) return `user:${session.userId}:${session.sessionId.slice(0, 12)}`;
  return `ip:${clientIp(c)}`;
}

interface RateLimiter {
  (c: Context, next: Next): Promise<Response | void>;
  store: RateStore;
}

export interface LimiterOptions {
  store?: RateStore;
  /** Namespaces keys so limiters can share one store. */
  prefix?: string;
}

function setHeaders(c: Context, limit: number, bucket: Bucket, now: number) {
  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(Math.max(0, limit - bucket.count)));
  c.header("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  void now;
}

function limited(c: Context, bucket: Bucket, now: number) {
  const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  c.header("Retry-After", String(retry));
  return apiError(c, 429, "RATE_LIMITED", `retry in ${retry}s`);
}

export interface KeyedLimiter {
  store: RateStore;
  /** Count one hit for `key`; a 429 response once over the limit. */
  hit(c: Context, key: string): Promise<Response | undefined>;
  /** Refuse (429) when `key` is already at the limit, without counting. */
  guard(c: Context, key: string): Promise<Response | undefined>;
}

/**
 * Limiter for a caller-chosen key (e.g. an integration id resolved from a
 * path token) rather than the requester's identity or IP. `limit` may be a
 * function so config is read per request; <= 0 disables the limiter.
 */
export function createKeyedLimiter(
  limit: number | (() => number),
  windowMs: number,
  opts: LimiterOptions = {},
): KeyedLimiter {
  const store = opts.store ?? new MemoryRateStore();
  const prefix = opts.prefix ?? "key";
  const max = () => (typeof limit === "function" ? limit() : limit);
  return {
    store,
    async hit(c, key) {
      const cap = max();
      if (cap <= 0) return undefined;
      const now = clock.ms();
      const bucket = await store.hit(`${prefix}:${key}`, windowMs, now);
      setHeaders(c, cap, bucket, now);
      return bucket.count > cap ? limited(c, bucket, now) : undefined;
    },
    async guard(c, key) {
      const cap = max();
      if (cap <= 0) return undefined;
      const now = clock.ms();
      const bucket = await store.peek(`${prefix}:${key}`, now);
      return bucket && bucket.count >= cap ? limited(c, bucket, now) : undefined;
    },
  };
}

/** Per-identity limiter (agent key / user / IP), mounted after requireSession. */
export function createRateLimiter(
  limitPerMin: number,
  opts: LimiterOptions = {},
): RateLimiter {
  const store = opts.store ?? new MemoryRateStore();
  const prefix = opts.prefix ?? "id";
  const mw = async (c: Context, next: Next) => {
    if (limitPerMin <= 0) return next();
    const now = clock.ms();
    const bucket = await store.hit(`${prefix}:${identityKey(c)}`, WINDOW_MS, now);
    setHeaders(c, limitPerMin, bucket, now);
    if (bucket.count > limitPerMin) return limited(c, bucket, now);
    return next();
  };
  mw.store = store;
  return mw;
}

function hasCredential(c: Context, sessionCookie: string): boolean {
  return Boolean(getCookie(c, sessionCookie) || c.req.header("authorization"));
}

/**
 * Anonymous-traffic limiter, mounted BEFORE authentication so unauthenticated
 * requests are counted (the per-identity limiter sits behind requireSession
 * and never sees them). Counts, per client IP:
 *   - every request that carries no credential, and
 *   - every credentialed request the API answers with 401 (bad/expired/
 *     guessed tokens).
 * Valid credentialed traffic is untouched, so a CI fleet behind one NAT is
 * not throttled by its own successful calls.
 */
export function createAnonymousLimiter(
  limitPerMin: number,
  sessionCookie: string,
  opts: LimiterOptions & { skip?: (path: string) => boolean } = {},
): RateLimiter {
  const store = opts.store ?? new MemoryRateStore();
  const prefix = opts.prefix ?? "anon";
  const mw = async (c: Context, next: Next) => {
    if (limitPerMin <= 0 || opts.skip?.(c.req.path)) return next();
    const key = `${prefix}:${clientIp(c)}`;
    const now = clock.ms();
    if (!hasCredential(c, sessionCookie)) {
      const bucket = await store.hit(key, WINDOW_MS, now);
      setHeaders(c, limitPerMin, bucket, now);
      if (bucket.count > limitPerMin) return limited(c, bucket, now);
      return next();
    }
    // credentialed: refuse only if this IP is already over its failure budget
    const live = await store.peek(key, now);
    if (live && live.count > limitPerMin) return limited(c, live, now);
    await next();
    if (c.res.status === 401) await store.hit(key, WINDOW_MS, clock.ms());
  };
  mw.store = store;
  return mw;
}

// Credential-guessing endpoints (login, bootstrap, invite accept, OAuth
// start/callback) share one tight per-IP budget. RATE_LIMIT_AUTH_PER_MIN=0
// disables it (tests).
export const authLimiter = createRateLimiter(config_.rateLimitAuthPerMin, {
  prefix: "auth",
});
