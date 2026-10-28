import { createServer, type Server } from "node:http";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  assertSafeOutboundUrl,
  isPrivateAddress,
  safeFetchText,
  safePost,
  webhookAllowPrivate,
} from "./net-guard.js";

const original = process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE;
afterEach(() => {
  if (original === undefined) delete process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE;
  else process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = original;
});
const guardOn = () => {
  process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "";
};

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
    "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1",
    "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "169.255.0.1",
    "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("assertSafeOutboundUrl", () => {
  it.each([
    "http://127.0.0.1/hook",
    "http://localhost:8080/hook",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/hook",
    "https://10.1.2.3/hook",
    "http://100.64.1.1/hook",
    "http://[fd00::1]/hook",
    "http://[::ffff:127.0.0.1]/hook",
    "http://metadata.google.internal/",
    "http://printer.local/",
  ])("rejects %s", async (u) => {
    guardOn();
    await expect(assertSafeOutboundUrl(u)).rejects.toThrow();
  });

  it("rejects non-http schemes and embedded credentials", async () => {
    guardOn();
    await expect(assertSafeOutboundUrl("ftp://8.8.8.8/")).rejects.toThrow(/http or https/);
    await expect(assertSafeOutboundUrl("https://user:pw@8.8.8.8/")).rejects.toThrow(/credentials/);
  });

  it("accepts a public IP literal", async () => {
    guardOn();
    await expect(assertSafeOutboundUrl("https://8.8.8.8/hook")).resolves.toBeUndefined();
  });

  it("allows private targets only when the opt-out env is set", async () => {
    guardOn();
    expect(webhookAllowPrivate()).toBe(false);
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "1";
    expect(webhookAllowPrivate()).toBe(true);
    await expect(assertSafeOutboundUrl("http://192.168.1.10/hook")).resolves.toBeUndefined();
  });
});

describe("safePost", () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      hits.push(rq.url ?? "");
      if (rq.url === "/redirect") {
        rs.writeHead(302, { location: "http://169.254.169.254/" }).end();
      } else rs.writeHead(204).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const init = { headers: { "content-type": "application/json" }, body: "{}", timeoutMs: 2000 };

  it("refuses private literals before connecting", async () => {
    guardOn();
    hits.length = 0;
    await expect(safePost(`http://127.0.0.1:${port}/x`, init)).rejects.toThrow(/non-public/);
    await expect(safePost("http://localhost/x", init)).rejects.toThrow(/not public/);
    expect(hits).toEqual([]);
  });

  it("delivers to private targets with the opt-out, and does not follow redirects", async () => {
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "1";
    await expect(safePost(`http://127.0.0.1:${port}/ok`, init)).resolves.toBe(204);
    await expect(safePost(`http://127.0.0.1:${port}/redirect`, init)).rejects.toThrow(/redirect/);
    expect(hits).toEqual(["/ok", "/redirect"]);
  });
});

describe("safeFetchText", () => {
  let server: Server;
  let port = 0;
  const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((rq, rs) => {
      hits.push(rq.url ?? "");
      if (rq.url === "/redirect") rs.writeHead(302, { location: "http://169.254.169.254/" }).end();
      else if (rq.url === "/big") rs.writeHead(200).end("x".repeat(5000));
      else if (rq.url === "/slow") setTimeout(() => rs.writeHead(200).end("late"), 500);
      else {
        let b = "";
        rq.on("data", (d) => (b += d));
        rq.on("end", () => rs.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ got: b, auth: rq.headers.authorization })));
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  const init = { method: "POST" as const, headers: { authorization: "Bearer k" }, body: "hi", timeoutMs: 2000, maxBytes: 1000 };

  it("never dials a private address or plain http to a public host with the guard on", async () => {
    guardOn();
    hits.length = 0;
    await expect(safeFetchText(`http://127.0.0.1:${port}/x`, init)).rejects.toThrow(/https/);
    await expect(safeFetchText(`https://127.0.0.1:${port}/x`, init)).rejects.toThrow(/non-public/);
    await expect(safeFetchText("https://localhost/x", init)).rejects.toThrow(/not public/);
    await expect(safeFetchText("http://example.com/x", init)).rejects.toThrow(/https/);
    expect(hits).toEqual([]);
  });

  it("returns status and body with the opt-out, refuses redirects, caps size and time", async () => {
    process.env.TALLYLINE_WEBHOOK_ALLOW_PRIVATE = "1";
    const ok = await safeFetchText(`http://127.0.0.1:${port}/ok`, init);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ got: "hi", auth: "Bearer k" });
    await expect(safeFetchText(`http://127.0.0.1:${port}/redirect`, init)).rejects.toThrow(/redirect/);
    await expect(safeFetchText(`http://127.0.0.1:${port}/big`, init)).rejects.toThrow();
    await expect(safeFetchText(`http://127.0.0.1:${port}/slow`, { ...init, timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
});
