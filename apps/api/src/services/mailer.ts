import { randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { config_ } from "../env.js";

// One interface for every transactional mail Tallyline sends. Call sites
// build a MailMessage and call mailer().send(); which transport delivers it
// is deployment config (MAIL_TRANSPORT), never a call-site decision.
//
// Transports:
//   log         default. Writes the message to the server log and, outside
//               production, to an in-memory dev inbox (GET /v1/dev/mail,
//               instance admins only). Nothing leaves the process.
//   smtp        SMTP_URL, e.g. smtp://user:pass@mail.example.com:587
//               (STARTTLS when offered) or smtps://...:465 (implicit TLS).
//   cloudflare  Cloudflare Email Sending REST API
//               (CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_EMAIL_API_TOKEN).
// Tests and local dev only ever use `log`; no real mail is sent from them.

export type MailKind = "password_reset" | "password_changed" | "email_verify";

export interface MailMessage {
  kind: MailKind;
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly transport: "log" | "smtp" | "cloudflare";
  send(msg: MailMessage): Promise<void>;
}

// ── log transport + dev inbox ────────────────────────────────────────────────

export interface InboxEntry extends MailMessage {
  id: string;
  from: string;
  sentAt: string;
}

const INBOX_MAX = 200;
const inbox: InboxEntry[] = [];

/** the dev inbox is live only for the log transport and never in production */
export function devInboxEnabled(): boolean {
  return mailer().transport === "log" && process.env.NODE_ENV !== "production";
}

export function devInbox(): InboxEntry[] {
  return devInboxEnabled() ? [...inbox].reverse() : [];
}

export function clearDevInbox(): void {
  inbox.length = 0;
}

export class LogMailer implements Mailer {
  readonly transport = "log" as const;
  constructor(private readonly from: string) {}

  async send(msg: MailMessage): Promise<void> {
    const entry: InboxEntry = {
      ...msg,
      id: randomBytes(6).toString("hex"),
      from: this.from,
      sentAt: new Date().toISOString(),
    };
    if (process.env.NODE_ENV !== "production") {
      inbox.push(entry);
      if (inbox.length > INBOX_MAX) inbox.shift();
    }
    if (process.env.NODE_ENV !== "test") {
      // the log transport is the self-host fallback: the operator reads
      // links out of the server log, so the body is printed in full
      console.log(
        `[mail:log] to=${msg.to} kind=${msg.kind} subject=${JSON.stringify(msg.subject)}\n${msg.text}`,
      );
    }
  }
}

// ── SMTP transport (minimal RFC 5321 client, no dependency) ─────────────────

interface SmtpTarget {
  host: string;
  port: number;
  implicitTls: boolean;
  user: string | null;
  pass: string | null;
}

export function parseSmtpUrl(raw: string): SmtpTarget {
  const u = new URL(raw);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") {
    throw new Error("SMTP_URL must start with smtp:// or smtps://");
  }
  const implicitTls = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: Number(u.port || (implicitTls ? 465 : 587)),
    implicitTls,
    user: u.username ? decodeURIComponent(u.username) : null,
    pass: u.password ? decodeURIComponent(u.password) : null,
  };
}

/** bare address out of `Name <addr>` */
export function addressOf(v: string): string {
  const m = v.match(/<([^>]+)>/);
  return (m ? m[1]! : v).trim();
}

function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, " ");
}

export function buildMime(from: string, msg: MailMessage, now = new Date()): string {
  const domain = addressOf(from).split("@")[1] ?? "localhost";
  const body = msg.text
    .replace(/\r?\n/g, "\r\n")
    // dot-stuffing (RFC 5321 4.5.2)
    .replace(/^\./gm, "..");
  return [
    `From: ${headerSafe(from)}`,
    `To: ${headerSafe(msg.to)}`,
    `Subject: ${headerSafe(msg.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

class SmtpConversation {
  private buf = "";
  private waiters: ((line: { code: number; text: string }) => void)[] = [];
  private failure: Error | null = null;

  constructor(private sock: net.Socket) {
    this.attach(sock);
  }

  attach(sock: net.Socket) {
    this.sock = sock;
    // no setEncoding: STARTTLS hands this raw socket to tls.connect later
    sock.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    sock.on("error", (e) => this.fail(e));
  }

  private fail(e: Error) {
    this.failure = e;
    for (const w of this.waiters.splice(0)) w({ code: 0, text: e.message });
  }

  private onData(d: string) {
    this.buf += d;
    // a reply is complete at a line whose 4th char is a space ("250 ok")
    for (;;) {
      const lines = this.buf.split("\r\n");
      const endIdx = lines.findIndex((l) => /^\d{3} /.test(l) || /^\d{3}$/.test(l));
      if (endIdx === -1) return;
      const reply = lines.slice(0, endIdx + 1);
      this.buf = lines.slice(endIdx + 1).join("\r\n");
      const code = Number(reply[endIdx]!.slice(0, 3));
      const w = this.waiters.shift();
      w?.({ code, text: reply.map((l) => l.slice(4)).join("\n") });
    }
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async cmd(line: string | null, expect: number[]): Promise<string> {
    if (line !== null) this.sock.write(`${line}\r\n`);
    const r = await this.read();
    if (!expect.includes(r.code)) {
      // never echo AUTH payloads back into errors
      const shown = line?.startsWith("AUTH") ? "AUTH" : (line ?? "greeting");
      throw new Error(`SMTP ${shown} failed: ${r.code} ${r.text}`);
    }
    return r.text;
  }
}

export class SmtpMailer implements Mailer {
  readonly transport = "smtp" as const;
  private readonly target: SmtpTarget;

  constructor(
    url: string,
    private readonly from: string,
    private readonly opts: { timeoutMs?: number; tlsOptions?: tls.ConnectionOptions } = {},
  ) {
    this.target = parseSmtpUrl(url);
  }

  async send(msg: MailMessage): Promise<void> {
    const t = this.target;
    const timeout = this.opts.timeoutMs ?? 15_000;
    const sock: net.Socket = t.implicitTls
      ? tls.connect({ host: t.host, port: t.port, servername: t.host, ...this.opts.tlsOptions })
      : net.connect({ host: t.host, port: t.port });
    sock.setTimeout(timeout, () => sock.destroy(new Error("SMTP timeout")));
    const conv = new SmtpConversation(sock);
    try {
      await conv.cmd(null, [220]);
      let ehlo = await conv.cmd("EHLO tallyline", [250]);
      if (!t.implicitTls && /^STARTTLS$/im.test(ehlo)) {
        await conv.cmd("STARTTLS", [220]);
        sock.removeAllListeners("data");
        sock.removeAllListeners("error");
        const secure = tls.connect({ socket: sock, servername: t.host, ...this.opts.tlsOptions });
        secure.setTimeout(timeout, () => secure.destroy(new Error("SMTP timeout")));
        await new Promise<void>((res, rej) => {
          secure.once("secureConnect", () => res());
          secure.once("error", rej);
        });
        conv.attach(secure);
        ehlo = await conv.cmd("EHLO tallyline", [250]);
      }
      if (t.user !== null) {
        const plain = Buffer.from(`\u0000${t.user}\u0000${t.pass ?? ""}`).toString("base64");
        await conv.cmd(`AUTH PLAIN ${plain}`, [235]);
      }
      await conv.cmd(`MAIL FROM:<${addressOf(this.from)}>`, [250]);
      await conv.cmd(`RCPT TO:<${addressOf(msg.to)}>`, [250, 251]);
      await conv.cmd("DATA", [354]);
      await conv.cmd(`${buildMime(this.from, msg)}\r\n.`, [250]);
      await conv.cmd("QUIT", [221]).catch(() => undefined);
    } finally {
      sock.destroy();
    }
  }
}

// ── Cloudflare Email Sending (REST) ──────────────────────────────────────────

export class CloudflareMailer implements Mailer {
  readonly transport = "cloudflare" as const;

  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/email/sending/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          to: msg.to,
          from: addressOf(this.from),
          subject: msg.subject,
          text: msg.text,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) {
      throw new Error(`Cloudflare Email Sending failed: HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
    if (body && body.success === false) {
      throw new Error("Cloudflare Email Sending rejected the message");
    }
  }
}

// ── selection ────────────────────────────────────────────────────────────────

export function createMailer(cfg: {
  mailTransport: string;
  mailFrom: string;
  smtpUrl: string;
  cloudflareAccountId: string;
  cloudflareEmailApiToken: string;
}): Mailer {
  switch (cfg.mailTransport) {
    case "":
    case "log":
      return new LogMailer(cfg.mailFrom);
    case "smtp":
      if (!cfg.smtpUrl) throw new Error("MAIL_TRANSPORT=smtp requires SMTP_URL");
      return new SmtpMailer(cfg.smtpUrl, cfg.mailFrom);
    case "cloudflare":
      if (!cfg.cloudflareAccountId || !cfg.cloudflareEmailApiToken) {
        throw new Error(
          "MAIL_TRANSPORT=cloudflare requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN",
        );
      }
      return new CloudflareMailer(cfg.cloudflareAccountId, cfg.cloudflareEmailApiToken, cfg.mailFrom);
    default:
      throw new Error(`unknown MAIL_TRANSPORT '${cfg.mailTransport}' (log, smtp, cloudflare)`);
  }
}

let current: Mailer | null = null;

export function mailer(): Mailer {
  current ??= createMailer(config_);
  return current;
}

/** test hook */
export function setMailer(m: Mailer | null): void {
  current = m;
}
