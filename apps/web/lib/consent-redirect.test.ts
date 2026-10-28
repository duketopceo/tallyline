import { describe, expect, it } from "vitest";
import { isNavigableRedirect } from "./consent-redirect";

describe("isNavigableRedirect", () => {
  it("allows web and loopback redirects", () => {
    expect(isNavigableRedirect("https://claude.ai/api/mcp/auth_callback?code=x")).toBe(true);
    expect(isNavigableRedirect("http://127.0.0.1:53124/callback?code=x")).toBe(true);
  });
  it("allows reverse-domain private-use app schemes", () => {
    expect(isNavigableRedirect("app.tallyline.ios:/oauth/callback?code=x&state=y")).toBe(true);
    expect(isNavigableRedirect("com.example.app://cb?code=x")).toBe(true);
  });
  it("refuses script, data, file and dotless schemes, and garbage", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "vbscript:x",
      "myapp:/cb",
      "not a url",
      "",
    ]) {
      expect(isNavigableRedirect(bad), bad).toBe(false);
    }
  });
});
