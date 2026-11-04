import { describe, expect, it } from "vitest";
import {
  assertProductionSecrets,
  DEV_JWT_SECRET,
  providerSecretsWarning,
  StartupGuardError,
  warnMissingProviderSecrets,
} from "./startup-guard.js";

const strong = "a".repeat(64);
const strong2 = "b".repeat(64);

describe("assertProductionSecrets", () => {
  it("does nothing outside production", () => {
    for (const nodeEnv of [undefined, "development", "test"]) {
      expect(() =>
        assertProductionSecrets({
          nodeEnv,
          jwtSecret: DEV_JWT_SECRET,
          authSecretKey: "",
        }),
      ).not.toThrow();
    }
  });

  it("rejects unset, empty and whitespace JWT_SECRET in production", () => {
    for (const jwtSecret of [undefined, "", "   "]) {
      expect(() =>
        assertProductionSecrets({ nodeEnv: "production", jwtSecret, authSecretKey: "" }),
      ).toThrow(/JWT_SECRET is unset or empty/);
    }
  });

  it("rejects the dev default and short secrets, naming the variable", () => {
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: DEV_JWT_SECRET,
        authSecretKey: "",
      }),
    ).toThrow(/JWT_SECRET is set to a known default/);
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: "short",
        authSecretKey: "",
      }),
    ).toThrow(StartupGuardError);
  });

  it("allows a strong JWT_SECRET with AUTH_SECRET_KEY unset", () => {
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: undefined,
      }),
    ).not.toThrow();
  });

  it("validates AUTH_SECRET_KEY when present", () => {
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: "change-me",
      }),
    ).toThrow(/AUTH_SECRET_KEY is set to a known default/);
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: "tiny",
      }),
    ).toThrow(/AUTH_SECRET_KEY is shorter/);
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: strong,
      }),
    ).toThrow(/must differ/);
    expect(() =>
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: strong2,
      }),
    ).not.toThrow();
  });

  it("never echoes the secret value in the error", () => {
    try {
      assertProductionSecrets({
        nodeEnv: "production",
        jwtSecret: "hunter2-secret-value",
        authSecretKey: "",
      });
    } catch (e) {
      expect((e as Error).message).not.toContain("hunter2");
    }
  });
});

describe("missing AUTH_SECRET_KEY warning", () => {
  it("warns once in production when the key is absent", () => {
    const lines: string[] = [];
    warnMissingProviderSecrets(
      { nodeEnv: "production", jwtSecret: strong, authSecretKey: "" },
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("AUTH_SECRET_KEY");
    expect(lines[0]).toContain("SECRETS_KEY_MISSING");
    expect(
      providerSecretsWarning({
        nodeEnv: "production",
        jwtSecret: strong,
        authSecretKey: undefined,
      }),
    ).toContain("AUTH_SECRET_KEY");
  });

  it("stays quiet when the key is set or outside production", () => {
    for (const input of [
      { nodeEnv: "production", jwtSecret: strong, authSecretKey: strong2 },
      { nodeEnv: "development", jwtSecret: DEV_JWT_SECRET, authSecretKey: "" },
      { nodeEnv: undefined, jwtSecret: undefined, authSecretKey: undefined },
    ]) {
      expect(providerSecretsWarning(input)).toBeNull();
    }
  });
});
