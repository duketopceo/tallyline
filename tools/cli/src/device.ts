import { CliError } from "./cli-error.js";
import type { FetchLike } from "./client.js";

// Browser sign-in for the CLI: RFC 8628 device authorization against
// /v1/auth/device/code and /v1/auth/device/token. The CLI shows a short code,
// the person approves it in a browser they are already signed in to, and the
// CLI is handed a personal access token once. No pasting, no env vars.

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** seconds until the code stops working */
  expiresIn: number;
  /** seconds between polls */
  interval: number;
}

/** The server has no browser sign-in (older version, or not a Tallyline server). */
export class DeviceUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceUnsupported";
  }
}

const TIMEOUT_MS = 15_000;

function base(server: string): string {
  return server.replace(/\/+$/, "");
}

async function post(server: string, path: string, body: unknown, fetchImpl: FetchLike): Promise<{ status: number; data: unknown }> {
  let res: Response;
  try {
    res = await fetchImpl(
      new Request(`${base(server)}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(1, `could not reach ${new URL(server).host}: ${msg}`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  return { status: res.status, data };
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});

/** Only ever hand a web address to the browser: never file:, javascript: and friends. */
export function isOpenableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function startDevice(server: string, clientName: string, fetchImpl: FetchLike): Promise<DeviceStart> {
  const { status, data } = await post(server, "/v1/auth/device/code", { clientName }, fetchImpl);
  const d = obj(data);
  if (status === 404 || status === 405) {
    throw new DeviceUnsupported("this server does not offer browser sign-in");
  }
  if (status === 429) throw new CliError(1, "too many sign-in attempts from this computer; wait a minute and try again");
  if (status !== 200 || typeof d.device_code !== "string" || typeof d.user_code !== "string" || typeof d.verification_uri !== "string") {
    // 200 with something else means this is not a Tallyline server at all
    if (status === 200) throw new DeviceUnsupported("this server did not answer like a Tallyline server");
    const msg = typeof obj(d.error).message === "string" ? (obj(d.error).message as string) : `HTTP ${status}`;
    throw new CliError(1, `could not start browser sign-in: ${msg}`);
  }
  const uri = d.verification_uri;
  const complete = typeof d.verification_uri_complete === "string" ? d.verification_uri_complete : uri;
  if (!isOpenableUrl(uri) || !isOpenableUrl(complete)) {
    throw new CliError(1, "the server returned a sign-in address that is not a web address; refusing to use it");
  }
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUri: uri,
    verificationUriComplete: complete,
    expiresIn: typeof d.expires_in === "number" ? d.expires_in : 600,
    interval: typeof d.interval === "number" && d.interval >= 1 ? d.interval : 5,
  };
}

export interface WaitOptions {
  server: string;
  start: DeviceStart;
  fetch: FetchLike;
  /** injectable for tests; defaults to a real timer */
  sleep?: (ms: number) => Promise<void>;
  /** called each time the server says "not yet" */
  onWaiting?: () => void;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls until the person approves or denies, the code expires, or the server gives up. */
export async function waitForDeviceToken(o: WaitOptions): Promise<string> {
  const sleep = o.sleep ?? realSleep;
  let interval = o.start.interval;
  let waited = 0;
  for (;;) {
    await sleep(interval * 1000);
    waited += interval;
    const { status, data } = await post(o.server, "/v1/auth/device/token", { deviceCode: o.start.deviceCode }, o.fetch);
    const d = obj(data);
    if (status === 200 && typeof d.access_token === "string") return d.access_token;
    const code = typeof d.error === "string" ? d.error : undefined;
    if (code === "authorization_pending") {
      o.onWaiting?.();
    } else if (code === "slow_down") {
      interval = typeof d.interval === "number" && d.interval > interval ? d.interval : interval + 5;
    } else if (code === "access_denied") {
      throw new CliError(1, "you chose Deny in the browser, so nothing was connected");
    } else if (code === "expired_token") {
      throw new CliError(1, "that code expired before it was approved; run tallyline connect again for a fresh one");
    } else if (status === 429) {
      interval += 5;
    } else {
      throw new CliError(1, `browser sign-in stopped unexpectedly (${code ?? `HTTP ${status}`}); try tallyline connect again`);
    }
    if (waited > o.start.expiresIn + interval) {
      throw new CliError(1, "that code expired before it was approved; run tallyline connect again for a fresh one");
    }
  }
}
