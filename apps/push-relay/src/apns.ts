import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, constants, type ClientHttp2Session } from "node:http2";
import { b64url, type ApnsEnv } from "./protocol.js";

// Token-based APNs over HTTP/2. The .p8 key lives only here, never on a
// Tallyline server.

export interface ApnsResult {
  status: number;
  reason?: string;
}

export interface ApnsSender {
  send(token: string, env: ApnsEnv, payload: Record<string, unknown>): Promise<ApnsResult>;
  close(): void;
}

export interface ApnsConfig {
  teamId: string;
  keyId: string;
  /** PEM text of the AuthKey_XXXX.p8 file */
  privateKeyPem: string;
  /** the iOS app's bundle id */
  topic: string;
}

const HOSTS: Record<ApnsEnv, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** ES256 provider token. Apple wants a fresh one at most every 20 minutes and
 *  rejects ones older than an hour; refresh every 40. */
export function providerToken(key: KeyObject, teamId: string, keyId: string, nowSec: number): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })));
  const claims = b64url(Buffer.from(JSON.stringify({ iss: teamId, iat: nowSec })));
  const sig = sign("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${claims}.${b64url(sig)}`;
}

export function http2Apns(cfg: ApnsConfig, now: () => number = Date.now): ApnsSender {
  const key = createPrivateKey(cfg.privateKeyPem);
  let jwt: { value: string; at: number } | null = null;
  const sessions = new Map<ApnsEnv, ClientHttp2Session>();

  const bearer = () => {
    const t = Math.floor(now() / 1000);
    if (!jwt || t - jwt.at > 40 * 60) jwt = { value: providerToken(key, cfg.teamId, cfg.keyId, t), at: t };
    return jwt.value;
  };
  const session = (env: ApnsEnv) => {
    const s = sessions.get(env);
    if (s && !s.closed && !s.destroyed) return s;
    const fresh = connect(HOSTS[env]);
    fresh.on("error", () => sessions.delete(env));
    fresh.on("close", () => sessions.delete(env));
    sessions.set(env, fresh);
    return fresh;
  };

  return {
    send(token, env, payload) {
      return new Promise((resolve) => {
        const body = Buffer.from(JSON.stringify(payload));
        const req = session(env).request({
          [constants.HTTP2_HEADER_METHOD]: "POST",
          [constants.HTTP2_HEADER_PATH]: `/3/device/${token}`,
          authorization: `bearer ${bearer()}`,
          "apns-topic": cfg.topic,
          "apns-push-type": "alert",
          "apns-priority": "10",
          "apns-expiration": String(Math.floor(now() / 1000) + 3600),
          "content-type": "application/json",
          "content-length": String(body.length),
        });
        let status = 0;
        let text = "";
        req.setTimeout(10_000, () => req.close(constants.NGHTTP2_CANCEL));
        req.on("response", (h) => {
          status = Number(h[constants.HTTP2_HEADER_STATUS] ?? 0);
        });
        req.setEncoding("utf8");
        req.on("data", (c: string) => {
          if (text.length < 4096) text += c;
        });
        req.on("end", () => {
          let reason: string | undefined;
          try {
            const parsed = (JSON.parse(text) as { reason?: unknown }).reason;
            if (typeof parsed === "string") reason = parsed.slice(0, 64);
          } catch {
            // empty body on success
          }
          resolve(reason ? { status, reason } : { status });
        });
        req.on("error", () => resolve({ status: 0, reason: "connection" }));
        req.end(body);
      });
    },
    close() {
      for (const s of sessions.values()) s.close();
      sessions.clear();
    },
  };
}

/** a device that will never accept pushes again; the server should forget it */
export function isGone(r: ApnsResult): boolean {
  return r.status === 410 || (r.status === 400 && (r.reason === "BadDeviceToken" || r.reason === "DeviceTokenNotForTopic"));
}
