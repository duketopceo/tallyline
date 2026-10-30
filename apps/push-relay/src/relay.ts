import type { IncomingMessage, ServerResponse } from "node:http";
import { isGone, type ApnsSender } from "./apns.js";
import {
  DEVICE_TOKEN,
  MAX_SKEW_MS,
  apnsPayload,
  ed25519Public,
  openHandle,
  parsePing,
  sealHandle,
  serverKeyId,
  verifyBody,
  type ApnsEnv,
} from "./protocol.js";

// The relay's HTTP surface. Three routes, no database:
//   GET  /health
//   POST /v1/handles  {token, environment, serverKey}  -> {handle}
//   POST /v1/push     signed ping                       -> 202 | 410 {gone}

export interface RelayOptions {
  handleKey: Buffer;
  apns: ApnsSender;
  now?: () => number;
  /** per handle, per minute */
  perHandle?: number;
  /** per server key, per minute */
  perServer?: number;
  /** handle minting, per client address, per minute */
  perIp?: number;
  log?: (line: Record<string, unknown>) => void;
  /** caller address for the minting limit; main.ts decides whether to trust a proxy header */
  clientIp?: (req: IncomingMessage) => string;
}

const MAX_BODY = 4096;

/** fixed one-minute windows; memory is bounded by pruning old windows */
export class Window {
  private counts = new Map<string, { n: number; w: number }>();
  constructor(
    private limit: number,
    private now: () => number,
  ) {}
  hit(key: string): boolean {
    const w = Math.floor(this.now() / 60_000);
    const cur = this.counts.get(key);
    if (!cur || cur.w !== w) {
      if (this.counts.size > 50_000) for (const [k, v] of this.counts) if (v.w !== w) this.counts.delete(k);
      this.counts.set(key, { n: 1, w });
      return true;
    }
    cur.n += 1;
    return cur.n <= this.limit;
  }
}

/** remembers nonces long enough to cover the clock window */
class Nonces {
  private seen = new Map<string, number>();
  constructor(private now: () => number) {}
  fresh(key: string): boolean {
    const t = this.now();
    if (this.seen.size > 100_000) for (const [k, exp] of this.seen) if (exp < t) this.seen.delete(k);
    const exp = this.seen.get(key);
    if (exp !== undefined && exp >= t) return false;
    this.seen.set(key, t + 2 * MAX_SKEW_MS);
    return true;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", () => resolve(null));
  });
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

const err = (res: ServerResponse, status: number, code: string, message: string) =>
  send(res, status, { error: { code, message } });

export function createRelay(o: RelayOptions) {
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => undefined);
  const perHandle = new Window(o.perHandle ?? 30, now);
  const perServer = new Window(o.perServer ?? 600, now);
  const perIp = new Window(o.perIp ?? 30, now);
  const nonces = new Nonces(now);
  const clientIp = o.clientIp ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? "?");

  async function handles(req: IncomingMessage, res: ServerResponse) {
    if (!perIp.hit(clientIp(req))) return err(res, 429, "RATE_LIMITED", "too many requests");
    const raw = await readBody(req);
    if (!raw) return err(res, 413, "TOO_LARGE", "body too large");
    let b: { token?: unknown; environment?: unknown; serverKey?: unknown };
    try {
      b = JSON.parse(raw.toString("utf8")) as typeof b;
    } catch {
      return err(res, 400, "BAD_JSON", "body must be JSON");
    }
    if (typeof b.token !== "string" || !DEVICE_TOKEN.test(b.token)) {
      return err(res, 400, "BAD_TOKEN", "token must be the APNs device token in hex");
    }
    if (b.environment !== "sandbox" && b.environment !== "production") {
      return err(res, 400, "BAD_ENV", "environment must be sandbox or production");
    }
    const key = typeof b.serverKey === "string" ? Buffer.from(b.serverKey, "base64url") : Buffer.alloc(0);
    if (!ed25519Public(key)) return err(res, 400, "BAD_SERVER_KEY", "serverKey must be a base64url Ed25519 public key");
    const handle = sealHandle(o.handleKey, b.token.toLowerCase(), b.environment as ApnsEnv, key, now());
    log({ ev: "handle", server: serverKeyId(key) });
    return send(res, 201, { handle });
  }

  async function push(req: IncomingMessage, res: ServerResponse) {
    const keyHeader = req.headers["x-tallyline-server-key"];
    const sigHeader = req.headers["x-tallyline-signature"];
    if (typeof keyHeader !== "string" || typeof sigHeader !== "string") {
      return err(res, 401, "UNSIGNED", "missing server key or signature");
    }
    const key = Buffer.from(keyHeader, "base64url");
    const sid = key.length === 32 ? serverKeyId(key) : "";
    if (!sid) return err(res, 401, "BAD_SIGNATURE", "bad server key");
    if (!perServer.hit(sid)) return err(res, 429, "RATE_LIMITED", "too many pings from this server");

    const raw = await readBody(req);
    if (!raw) return err(res, 413, "TOO_LARGE", "body too large");
    if (!verifyBody(key, raw, Buffer.from(sigHeader, "base64url"))) {
      return err(res, 401, "BAD_SIGNATURE", "signature does not match");
    }
    const ping = parsePing(raw.toString("utf8"));
    if (!ping) return err(res, 400, "BAD_PING", "malformed ping");
    if (Math.abs(now() - ping.ts) > MAX_SKEW_MS) return err(res, 401, "STALE", "timestamp outside the allowed window");
    if (!nonces.fresh(`${sid}:${ping.nonce}`)) return err(res, 409, "REPLAY", "nonce already used");

    const h = openHandle(o.handleKey, ping.handle);
    // a handle sealed for a different server is treated exactly like garbage
    if (!h || h.serverKeyId !== sid) return send(res, 410, { gone: true, reason: "unknown handle" });
    if (!perHandle.hit(ping.handle)) return err(res, 429, "RATE_LIMITED", "too many pings for this device");

    const r = await o.apns.send(h.token, h.env, apnsPayload(ping.kind, ping.badge));
    log({ ev: "push", server: sid, kind: ping.kind, status: r.status, ...(r.reason ? { reason: r.reason } : {}) });
    if (r.status === 200) return send(res, 202, { ok: true });
    if (isGone(r)) return send(res, 410, { gone: true, reason: r.reason ?? "unregistered" });
    if (r.status === 429) return err(res, 429, "UPSTREAM_RATE_LIMITED", "APNs asked to slow down");
    return err(res, 502, "UPSTREAM", "APNs did not accept the push");
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });
      if (req.method === "POST" && path === "/v1/handles") return await handles(req, res);
      if (req.method === "POST" && path === "/v1/push") return await push(req, res);
      return err(res, 404, "NOT_FOUND", "no such route");
    } catch {
      if (!res.headersSent) err(res, 500, "INTERNAL", "relay error");
    }
  };
}
