import { describe, expect, it } from "vitest";
import { adminChecklist, memberChecklist, progress, type SystemStatus } from "./setup-checklist";

const healthy: SystemStatus = {
  version: null,
  revision: null,
  database: { ok: true, latencyMs: 3 },
  backup: { state: "ok", lastBackupAt: "2026-10-28T00:00:00Z", ageHours: 5 },
  signIn: { password: true, providers: [{ key: "github", label: "GitHub" }] },
  ai: { configured: true, provider: { label: "OpenRouter", model: "m" }, problem: null },
  email: { transport: "smtp", configured: true },
  publicUrl: { webUrl: "https://tally.example.com", apiBaseUrl: "https://api.tally.example.com", issues: [] },
  workspace: { members: 4, agents: 1, issues: 12 },
};
const by = (s: SystemStatus, id: string) => adminChecklist(s).find((x) => x.id === id)!;

describe("adminChecklist", () => {
  it("a healthy install is all set", () => {
    const p = progress(adminChecklist(healthy));
    expect(p.allSet).toBe(true);
    expect(adminChecklist(healthy).every((s) => s.state === "done")).toBe(true);
  });
  it("backups not configured is attention with a next action, not a failure", () => {
    const s = by({ ...healthy, backup: { state: "not_configured", lastBackupAt: null, ageHours: null } }, "backups");
    expect(s.state).toBe("attention");
    expect(s.href).toBeTruthy();
    expect(s.detail).toMatch(/not set up/i);
  });
  it("stale backups say how old", () => {
    expect(by({ ...healthy, backup: { state: "stale", lastBackupAt: "x", ageHours: 72.4 } }, "backups").detail).toContain("72 hours");
  });
  it("log-only email is attention", () => {
    expect(by({ ...healthy, email: { transport: "log", configured: false } }, "email").state).toBe("attention");
  });
  it("optional steps never block all-set", () => {
    const s: SystemStatus = {
      ...healthy,
      ai: { configured: false, provider: null, problem: null },
      workspace: { members: 4, agents: 0, issues: 12 },
    };
    expect(progress(adminChecklist(s)).allSet).toBe(true);
    expect(by(s, "ai").state).toBe("todo");
  });
  it("a database that is down comes first and is attention", () => {
    const steps = adminChecklist({ ...healthy, database: { ok: false, latencyMs: null } });
    expect(steps[0]).toMatchObject({ id: "database", state: "attention" });
    expect(progress(steps).allSet).toBe(false);
  });
  it("no way to sign in is flagged", () => {
    expect(by({ ...healthy, signIn: { password: false, providers: [] } }, "sign-in").state).toBe("attention");
  });
  it("an unreadable AI key is reported with the fix", () => {
    const s = by({ ...healthy, ai: { configured: false, provider: null, problem: "AI_KEY_UNREADABLE" } }, "ai");
    expect(s.state).toBe("attention");
    expect(s.action).toBe("Fix");
    expect(s.href).toBe("/settings/ai");
  });
  it("an unconnected AI provider links to Settings > AI", () => {
    const s = by({ ...healthy, ai: { configured: false, provider: null, problem: null } }, "ai");
    expect(s).toMatchObject({ state: "todo", optional: true, href: "/settings/ai", action: "Connect" });
  });
  it("a workspace of one invites people", () => {
    expect(by({ ...healthy, workspace: { members: 1, agents: 0, issues: 0 } }, "people").href).toBe("/settings/invites");
  });
  it("never puts an address-looking secret in the copy", () => {
    const text = JSON.stringify(adminChecklist(healthy));
    expect(text).not.toMatch(/secret|password":"|apikey/i);
  });
});

describe("memberChecklist", () => {
  it("shows nothing about the server", () => {
    const text = JSON.stringify(memberChecklist(0)).toLowerCase();
    for (const w of ["backup", "database", "email", "sign-in"]) expect(text).not.toContain(w);
  });
  it("marks the first issue done once there is one", () => {
    expect(memberChecklist(3)[0]!.state).toBe("done");
    expect(memberChecklist(0)[0]!.state).toBe("todo");
  });
});
