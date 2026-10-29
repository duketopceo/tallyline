import { describe, expect, it } from "vitest";
import { loginReturnQuery } from "./login-return";

describe("loginReturnQuery", () => {
  it("brings the MCP consent page back with its request", () => {
    expect(loginReturnQuery("/oauth/consent", "?request=abc")).toBe(
      "?return_to=%2Foauth%2Fconsent%3Frequest%3Dabc",
    );
  });
  it("brings the CLI device page back with its code", () => {
    expect(loginReturnQuery("/device", "?code=BCDF-GHJK")).toBe(
      "?return_to=%2Fdevice%3Fcode%3DBCDF-GHJK",
    );
    expect(loginReturnQuery("/device", "")).toBe("?return_to=%2Fdevice");
  });
  it("leaves every other page on the default landing", () => {
    for (const p of ["/my-issues", "/devices", "/device/x", "/deviceish", "/settings/tokens"]) {
      expect(loginReturnQuery(p, "?a=1"), p).toBe("");
    }
  });
});
