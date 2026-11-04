import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isSentryAlert,
  normalizeFirstPartyReport,
  normalizeSentryAlert,
} from "./intake-normalize.js";

const fx = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../test/fixtures/sentry/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

describe("normalizeFirstPartyReport", () => {
  it("fills provider, trims the title and keeps the body's line breaks", () => {
    const input = normalizeFirstPartyReport({
      kind: "bug",
      title: "  Checkout   hangs  ",
      body: "Steps:\n1. open cart\n2. pay\n",
    });
    expect(input).toEqual({
      kind: "bug",
      title: "Checkout hangs",
      body: "Steps:\n1. open cart\n2. pay",
      provider: "intake",
      fingerprint: undefined,
      externalId: undefined,
      url: undefined,
      severity: undefined,
      occurredAt: undefined,
      payload: undefined,
    });
  });

  it("drops a non-https url and normalises the timestamp", () => {
    const input = normalizeFirstPartyReport({
      kind: "error",
      title: "boom",
      url: "http://internal.example/oops",
      occurredAt: "2026-11-03T18:20:31Z",
    });
    expect(input.url).toBeUndefined();
    expect(input.occurredAt).toBe("2026-11-03T18:20:31.000Z");
  });
});

describe("normalizeSentryAlert", () => {
  it("maps a captured issue alert to the same IntakeInput shape", () => {
    const { items, dropped } = normalizeSentryAlert(fx("issue-alert"));
    expect(dropped).toBe(0);
    expect(items).toHaveLength(1);
    const [event] = items;

    // same keys as the first-party path: one normaliser, one shape
    const firstParty = normalizeFirstPartyReport({ kind: "error", title: "x" });
    expect(Object.keys(event!).sort()).toEqual(Object.keys(firstParty).sort());

    expect(event).toMatchObject({
      kind: "error",
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      provider: "sentry",
      severity: "error",
      fingerprint: "sentry:portal-ui/4121",
      externalId: "sentry:c0ffee1d2e3f4a5b6c7d8e9f0a1b2c3d",
      url: "https://errors.pacehq.io/organizations/pace/issues/4121/events/c0ffee1d2e3f4a5b6c7d8e9f0a1b2c3d/",
      occurredAt: "2026-11-03T18:20:31.000Z",
    });
    expect(event!.body).toContain("Project: portal-ui");
    expect(event!.body).toContain("Culprit: src/portal/checkout.ts in submitOrder");
    expect(event!.body).toContain("environment: production");
    expect(event!.body).toContain("Release: portal@1.4.2");
  });

  it("ignores workflow notifications that are not new errors", () => {
    const body = fx("issue-alert") as Record<string, unknown>;
    expect(normalizeSentryAlert({ ...body, action: "resolved" }).items).toHaveLength(0);
    expect(normalizeSentryAlert({ ...body, action: "assigned" }).items).toHaveLength(0);
  });

  it("maps level to severity, debug included", () => {
    const base = fx("issue-alert") as { data: { event: Record<string, unknown> } };
    for (const [level, severity] of [
      ["fatal", "fatal"],
      ["warning", "warning"],
      ["info", "info"],
      ["debug", "info"],
      ["mystery", "error"],
    ] as const) {
      const body = { ...base, data: { event: { ...base.data.event, level } } };
      expect(normalizeSentryAlert(body).items[0]!.severity).toBe(severity);
    }
  });

  it("accepts a bare event and drops a non-https link", () => {
    const bare = {
      event_id: "abc123",
      title: "Boom",
      level: "fatal",
      url: "http://plain.example/event",
      tags: { region: "us-east", empty: "" },
    };
    expect(isSentryAlert(bare)).toBe(true);
    const [item] = normalizeSentryAlert(bare).items;
    expect(item).toMatchObject({
      title: "Boom",
      severity: "fatal",
      fingerprint: "sentry:abc123",
      externalId: "sentry:abc123",
    });
    expect(item!.url).toBeUndefined();
    expect(item!.body).toContain("region: us-east");
    expect(item!.body).not.toContain("empty");
  });

  it("does not mistake a GlitchTip alert for a Sentry one", () => {
    expect(isSentryAlert({ text: "x", attachments: [] })).toBe(false);
    expect(isSentryAlert(null)).toBe(false);
    expect(isSentryAlert("x")).toBe(false);
  });
});
