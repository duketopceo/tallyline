import { describe, expect, it } from "vitest";
import { POST as rotate } from "../app/api/settings/agents/[id]/keys/[keyId]/rotate/route";
import { checkBridgeRequest } from "./csrf";

const url = "https://app.example/api/settings/agents/a/keys/k/rotate";
const mk = (headers: Record<string, string>, method = "POST") =>
  new Request(url, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) });
const json = { "content-type": "application/json" };

describe("bridge CSRF guard", () => {
  it("allows GET and HEAD without checks", () => {
    expect(checkBridgeRequest(mk({}, "GET"))).toBeNull();
  });
  it("allows same-origin by Sec-Fetch-Site or by matching Origin", () => {
    expect(checkBridgeRequest(mk({ ...json, "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(checkBridgeRequest(mk({ ...json, origin: "https://app.example" }))).toBeNull();
  });
  it("honours x-forwarded-host behind a proxy", () => {
    const r = new Request("http://localhost:3100/x", {
      method: "POST",
      headers: { ...json, origin: "https://app.example", "x-forwarded-host": "app.example" },
      body: "{}",
    });
    expect(checkBridgeRequest(r)).toBeNull();
  });
  it("rejects cross-origin, cross-site and header-less mutations", () => {
    expect(checkBridgeRequest(mk({ ...json, origin: "https://evil.test" }))?.status).toBe(403);
    expect(checkBridgeRequest(mk({ ...json, "sec-fetch-site": "cross-site" }))?.status).toBe(403);
    expect(checkBridgeRequest(mk({ ...json, "sec-fetch-site": "same-site" }))?.status).toBe(403);
    expect(checkBridgeRequest(mk({ ...json }))?.status).toBe(403);
  });
  it("rejects non-JSON bodies even from the same origin", () => {
    const res = checkBridgeRequest(
      mk({ "content-type": "text/plain", "sec-fetch-site": "same-origin" }),
    );
    expect(res?.status).toBe(415);
  });
});

describe("bodyless bridge mutations", () => {
  it("allows a same-origin POST with no body and no content-type", () => {
    const r = new Request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    expect(checkBridgeRequest(r)).toBeNull();
  });
  it("still refuses a cross-origin bodyless POST", () => {
    const r = new Request(url, { method: "POST", headers: { origin: "https://evil.test" } });
    expect(checkBridgeRequest(r)?.status).toBe(403);
  });
});

describe("rotate bridge route", () => {
  it("a cross-origin POST is 403 before any session or upstream work", async () => {
    const res = await rotate(mk({ ...json, origin: "https://evil.test" }), {
      params: Promise.resolve({ id: "a", keyId: "k" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
