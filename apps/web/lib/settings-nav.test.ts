import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { activeHref, backTarget, SETTINGS_SECTIONS, visibleSections } from "./settings-nav";

const appDir = fileURLToPath(new URL("../app/(app)/", import.meta.url));

describe("SETTINGS_SECTIONS", () => {
  it("groups settings the way the iOS sheet does", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.label)).toEqual([
      "Account",
      "Workspace",
      "Planning",
      "Agents and AI",
      "Integrations and access",
    ]);
  });

  it("points every item at a page that exists", () => {
    for (const item of SETTINGS_SECTIONS.flatMap((s) => s.items)) {
      expect(existsSync(`${appDir}${item.href.slice(1)}/page.tsx`), item.href).toBe(true);
    }
  });

  it("keeps every page the old tab strip linked to", () => {
    const hrefs = new Set(SETTINGS_SECTIONS.flatMap((s) => s.items.map((i) => i.href)));
    for (const href of [
      "/welcome", "/settings/members", "/settings/invites", "/settings/agents", "/settings/devices",
      "/settings/tokens", "/settings/labels", "/settings/projects", "/settings/cycles",
      "/settings/integrations", "/settings/ai", "/settings/providers", "/settings/workspace",
      "/settings/account", "/settings/appearance", "/settings/usage",
    ]) {
      expect(hrefs.has(href), href).toBe(true);
    }
  });
});

describe("visibleSections", () => {
  it("shows the dev inbox to instance admins only", () => {
    const has = (admin: boolean) =>
      visibleSections({ isInstanceAdmin: admin }).some((s) => s.items.some((i) => i.href === "/settings/dev-inbox"));
    expect(has(true)).toBe(true);
    expect(has(false)).toBe(false);
  });
});

describe("activeHref", () => {
  it("marks nested pages under their parent item", () => {
    expect(activeHref("/settings/agents/connect")).toBe("/settings/agents");
    expect(activeHref("/settings/ai/openrouter")).toBe("/settings/ai");
    expect(activeHref("/settings/members")).toBe("/settings/members");
  });
  it("marks nothing on the overview or an unknown path", () => {
    expect(activeHref("/settings")).toBeNull();
    expect(activeHref("/settings/nope")).toBeNull();
  });
});

describe("backTarget", () => {
  it("returns to the parent page for nested routes and to the overview otherwise", () => {
    expect(backTarget("/settings/agents/connect")).toEqual({ href: "/settings/agents", label: "Agents" });
    expect(backTarget("/settings/ai/openrouter")).toEqual({ href: "/settings/ai", label: "AI" });
    expect(backTarget("/settings/members")).toEqual({ href: "/settings", label: "Settings" });
  });
});
