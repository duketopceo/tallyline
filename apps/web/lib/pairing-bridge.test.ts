import { describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", () => ({ proxy }));

import { POST } from "../app/api/settings/devices/pairing/route";

const minted = {
  code: "tlpair_abc123def456ghi789jkl",
  expiresAt: "2026-01-01T00:05:00.000Z",
  expiresIn: 300,
  pairingUrl: "tallyline://pair?server=https%3A%2F%2Fapi.tallyline.app&code=tlpair_abc123def456ghi789jkl",
};

describe("phone pairing bridge", () => {
  it("forwards the request to the active workspace's pairing API", async () => {
    proxy.mockResolvedValue(new Response(JSON.stringify({ error: { code: "EMAIL_UNVERIFIED" } }), { status: 403 }));
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    await POST(req);
    expect(proxy).toHaveBeenCalledWith(req, "/devices/pairing");
  });

  it("adds a QR of the pairing URL to a minted code", async () => {
    proxy.mockResolvedValue(new Response(JSON.stringify(minted), { status: 201 }));
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { code: string; qrSvg: string };
    expect(body.code).toBe(minted.code);
    expect(body.qrSvg.startsWith("<svg")).toBe(true);
    // a QR is a grid of dark modules; an empty or text-only SVG would not be
    expect(body.qrSvg).toContain("<path");
  });

  it("passes a failure through without a QR", async () => {
    proxy.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "EMAIL_UNVERIFIED", message: "confirm your email first" } }), {
        status: 403,
      }),
    );
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "EMAIL_UNVERIFIED", message: "confirm your email first" } });
  });

  it("answers 502 when the API mint is unreadable", async () => {
    proxy.mockResolvedValue(new Response("not json", { status: 201 }));
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PAIRING_BRIDGE_FAILED");
  });

  it("answers 502 when the bridge cannot reach the API", async () => {
    proxy.mockRejectedValue(new Error("ECONNREFUSED"));
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", { method: "POST" });
    const res = await POST(req);
    expect(res.status).toBe(502);
  });
});
