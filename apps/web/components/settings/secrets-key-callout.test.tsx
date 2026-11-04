import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { apiFailure, isSecretsKeyMissing, SECRETS_KEY_VAR } from "@/lib/secrets-key";
import { SecretsKeyCallout } from "./secrets-key-callout";

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("SecretsKeyCallout", () => {
  it("names AUTH_SECRET_KEY and the operator action", () => {
    const html = renderToStaticMarkup(<SecretsKeyCallout />);
    expect(html).toContain(SECRETS_KEY_VAR);
    expect(html).toContain("JWT_SECRET");
    expect(html).toContain("restart the API");
    // an operator callout, not a failure toast
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("SECRETS_KEY_MISSING");
  });
});

describe("apiFailure", () => {
  it("recognises the 503 code that must render the callout", async () => {
    const failure = await apiFailure(
      response(503, {
        error: {
          code: "SECRETS_KEY_MISSING",
          message: "this server has no AUTH_SECRET_KEY",
        },
      }),
      "could not save the endpoint",
    );
    expect(failure.code).toBe("SECRETS_KEY_MISSING");
    expect(isSecretsKeyMissing(failure)).toBe(true);
  });

  it("falls back for a body with no error and stays a normal toast", async () => {
    const failure = await apiFailure(
      new Response("not json", { status: 500 }),
      "could not save the endpoint",
    );
    expect(failure).toEqual({ code: undefined, message: "could not save the endpoint" });
    expect(isSecretsKeyMissing(failure)).toBe(false);
  });
});
