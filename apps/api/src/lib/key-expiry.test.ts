import { describe, expect, it } from "vitest";
import { parseKeyExpiryDays } from "./key-expiry.js";

describe("AGENT_KEY_DEFAULT_EXPIRY_DAYS parsing", () => {
  it("defaults to 90 when unset", () => {
    expect(parseKeyExpiryDays(undefined)).toBe(90);
  });
  it("accepts 0 (no default expiry) and ordinary values", () => {
    expect(parseKeyExpiryDays("0")).toBe(0);
    expect(parseKeyExpiryDays("30")).toBe(30);
    expect(parseKeyExpiryDays("3650")).toBe(3650);
  });
  it.each(["abc", "NaN", "-1", "3651", "99999999", "1.5", "", "  ", "Infinity"])(
    "fails startup on %j",
    (raw) => {
      expect(() => parseKeyExpiryDays(raw)).toThrow(/AGENT_KEY_DEFAULT_EXPIRY_DAYS/);
    },
  );
});
