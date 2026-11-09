import { describe, expect, it } from "vitest";
import { PASSWORD_MIN, validatePasswordChange, validateProfile, validateSlug } from "./account-forms";

describe("validateProfile", () => {
  it("trims the name and turns an empty picture into null", () => {
    expect(validateProfile("  Ada Lovelace ", "  ")).toEqual({
      ok: true,
      body: { name: "Ada Lovelace", avatarUrl: null },
    });
  });

  it("keeps an https picture address", () => {
    expect(validateProfile("Ada", "https://img.example.test/a.png")).toEqual({
      ok: true,
      body: { name: "Ada", avatarUrl: "https://img.example.test/a.png" },
    });
  });

  it("refuses a blank or over-long name", () => {
    expect(validateProfile("   ", "")).toEqual({ ok: false, error: "Enter a name." });
    const long = validateProfile("x".repeat(121), "");
    expect(long.ok).toBe(false);
  });

  it("refuses pictures that are not https web addresses", () => {
    for (const bad of ["http://img.example.test/a.png", "javascript:alert(1)", "not a url", "data:image/png;base64,AAAA"]) {
      expect(validateProfile("Ada", bad).ok, bad).toBe(false);
    }
  });
});

describe("validatePasswordChange", () => {
  it("accepts a long, different, confirmed password", () => {
    expect(validatePasswordChange("old-password-1", "new-password-1", "new-password-1")).toBeNull();
  });

  it("names the first problem in plain words", () => {
    expect(validatePasswordChange("", "new-password-1", "new-password-1")).toMatch(/current password/);
    expect(validatePasswordChange("old-password-1", "short", "short")).toContain(String(PASSWORD_MIN));
    expect(validatePasswordChange("same-password-1", "same-password-1", "same-password-1")).toMatch(/different/);
    expect(validatePasswordChange("old-password-1", "new-password-1", "new-password-2")).toMatch(/do not match/);
  });
});

describe("validateSlug", () => {
  it("accepts lowercase letters, numbers and hyphens", () => {
    expect(validateSlug("acme-hq-2")).toBeNull();
  });

  it("refuses short, long and malformed slugs", () => {
    expect(validateSlug("a")).not.toBeNull();
    expect(validateSlug("a".repeat(49))).not.toBeNull();
    expect(validateSlug("Acme")).not.toBeNull();
    expect(validateSlug("acme hq")).not.toBeNull();
    expect(validateSlug("acme_hq")).not.toBeNull();
  });
});
