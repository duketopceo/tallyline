import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_ATTACHMENTS,
  parseGlitchtipAlert,
  parseIssueUrl,
  renderBody,
  severityFromColor,
} from "./glitchtip.js";

const fx = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../test/fixtures/glitchtip/${name}.json`, import.meta.url),
      "utf8",
    ),
  );

describe("glitchtip payload parser", () => {
  it("parses a single error alert", () => {
    const { items, dropped } = parseGlitchtipAlert(fx("single-error"), null);
    expect(dropped).toBe(0);
    expect(items).toHaveLength(1);
    const [i] = items;
    expect(i).toMatchObject({
      title: "TypeError: Cannot read properties of undefined (reading 'id')",
      culprit: "src/portal/checkout.ts in submitOrder",
      url: "https://errors.pacehq.io/pace/issues/4121",
      fingerprint: "glitchtip:errors.pacehq.io/pace/4121",
      projectName: "portal-ui",
      severity: "error",
    });
    expect(i!.fields.map((f) => f.title)).toEqual([
      "Environment",
      "Server Name",
      "Release",
    ]);
  });

  it("parses every attachment of a batched alert", () => {
    const { items } = parseGlitchtipAlert(fx("batch"), null);
    expect(items.map((i) => i.projectName)).toEqual(["portal-ui", "strut", "wisp"]);
    expect(items.map((i) => i.severity)).toEqual(["error", "warning", "error"]);
  });

  it("maps colors to severities, unknown colors to error", () => {
    expect(severityFromColor("#e52b50")).toBe("error");
    expect(severityFromColor("#E9B949")).toBe("warning");
    expect(severityFromColor("#4b60b4")).toBe("info");
    expect(severityFromColor("#123456")).toBe("error");
    expect(severityFromColor(undefined)).toBe("error");
    expect(parseGlitchtipAlert(fx("info"), null).items[0]!.severity).toBe("info");
  });

  it("ignores uptime alerts and non-alert bodies", () => {
    for (const body of [fx("uptime"), {}, null, "x", { attachments: "no" }, { attachments: [null, 3] }]) {
      expect(parseGlitchtipAlert(body, null)).toEqual({ items: [], dropped: 0 });
    }
  });

  it("keeps the fingerprint stable across different alert text for one issue", () => {
    const a = parseGlitchtipAlert(fx("single-error"), null).items[0]!;
    const body = structuredClone(fx("single-error")) as {
      attachments: { title: string; text: string }[];
    };
    body.attachments[0]!.title = "A reworded title";
    body.attachments[0]!.text = "other culprit";
    const b = parseGlitchtipAlert(body, null).items[0]!;
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("requires https and the integration's host", () => {
    expect(parseIssueUrl("javascript:alert(1)")).toBeUndefined();
    expect(parseIssueUrl("http://errors.pacehq.io/pace/issues/1")).toBeUndefined();
    expect(parseIssueUrl("https://errors.pacehq.io/pace/issues/abc")).toBeUndefined();
    expect(parseIssueUrl("https://errors.pacehq.io/pace/uptime/12")).toBeUndefined();
    expect(parseIssueUrl("https://errors.pacehq.io/pace/issues/9")?.pk).toBe("9");
    const r = parseGlitchtipAlert(fx("foreign-host"), "errors.pacehq.io");
    expect(r).toEqual({ items: [], dropped: 1 });
  });

  it("caps the number of attachments per delivery and the field sizes", () => {
    const one = (fx("single-error") as { attachments: Record<string, unknown>[] })
      .attachments[0]!;
    const many = {
      attachments: Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => ({
        ...one,
        title: "x".repeat(2000),
        text: "y".repeat(5000),
        title_link: `https://errors.pacehq.io/pace/issues/${i + 1}`,
      })),
    };
    const r = parseGlitchtipAlert(many, null);
    expect(r.items).toHaveLength(MAX_ATTACHMENTS);
    expect(r.dropped).toBe(5);
    expect(r.items[0]!.title.length).toBeLessThanOrEqual(300);
    expect(r.items[0]!.culprit!.length).toBeLessThanOrEqual(500);
  });

  it("renders a body without markup from the payload", () => {
    const body = structuredClone(fx("single-error")) as {
      attachments: { text: string }[];
    };
    body.attachments[0]!.text = "`rm -rf` <img src=x> @everyone";
    const item = parseGlitchtipAlert(body, null).items[0]!;
    const text = renderBody(item);
    expect(text).toContain("Project: portal-ui");
    expect(text).not.toMatch(/[`<>@]/);
  });
});
