import { describe, expect, it } from "vitest";
import { middlewareRedirect, redirectTo } from "./redirect";

describe("redirectTo", () => {
  it("emits a relative Location — never the upstream Host", () => {
    // behind a tunnel/proxy the request Host can be an internal name like
    // localhost:3100; absolute redirects built from req.url would strand
    // the browser there. relative Location resolves on the public origin.
    const res = redirectTo("/login?error=exchange");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/login?error=exchange");
  });

  it("honours non-default status codes", () => {
    const res = redirectTo("/login", 303);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("middlewareRedirect", () => {
  const req = (headers: Record<string, string>, url = "http://localhost:3100/triage") =>
    new Request(url, { headers });

  it("builds an absolute Location on the public Host the browser used", () => {
    // Next's production edge runtime rejects a relative Location from
    // middleware (TypeError: Invalid URL), so middleware needs an absolute one.
    const res = middlewareRedirect(req({ host: "tallyline.app", "x-forwarded-proto": "https" }), "/login");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://tallyline.app/login");
  });

  it("keeps the query string and never uses the internal request URL host", () => {
    const res = middlewareRedirect(
      req({ host: "tallyline.app", "x-forwarded-proto": "https" }),
      "/login?return_to=%2Foauth%2Fconsent",
    );
    expect(res.headers.get("location")).toBe("https://tallyline.app/login?return_to=%2Foauth%2Fconsent");
  });

  it("ignores X-Forwarded-Host so a client cannot redirect to another origin", () => {
    const res = middlewareRedirect(
      req({ host: "tallyline.app", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
      "/login",
    );
    expect(res.headers.get("location")).toBe("https://tallyline.app/login");
  });

  it("falls back to the request URL scheme for a bogus forwarded proto", () => {
    const res = middlewareRedirect(req({ host: "localhost:3100", "x-forwarded-proto": "javascript" }), "/login");
    expect(res.headers.get("location")).toBe("http://localhost:3100/login");
  });

  it("only accepts same-origin paths", () => {
    expect(() => middlewareRedirect(req({ host: "tallyline.app" }), "//evil.example/x")).toThrow();
    expect(() => middlewareRedirect(req({ host: "tallyline.app" }), "https://evil.example/")).toThrow();
  });
});
