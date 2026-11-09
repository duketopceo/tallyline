import { describe, expect, it } from "vitest";
import { DEFAULT_LANDING } from "./landing";
import {
  activityText,
  errorChip,
  nextRowIndex,
  portfolioTotals,
  sortProjects,
  type PortfolioErrors,
  type PortfolioProject,
} from "./portfolio";
import { safeReturnTo } from "./session";

const noErrors: PortfolioErrors = { mapped: false, status: null, openCount: 0, openCapped: false, stale: false, lastSyncedAt: null };

function project(over: Partial<PortfolioProject> = {}): PortfolioProject {
  return {
    id: "p",
    name: "Alpha",
    description: null,
    status: "started",
    iconUrl: null,
    teamKey: null,
    startDate: null,
    targetDate: null,
    createdAt: "2026-01-01T00:00:00Z",
    counts: { triage: 0, backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, canceled: 0, duplicate: 0 },
    progress: { total: 0, done: 0, percent: 0 },
    milestones: { total: 0, completed: 0, items: [] },
    repos: [],
    recent: [],
    lastActivityAt: null,
    errors: noErrors,
    ...over,
  };
}

describe("sortProjects", () => {
  it("puts live projects first, nearest target date first, undated last, then by name", () => {
    const sorted = sortProjects([
      project({ id: "done", name: "A done", status: "completed", targetDate: "2026-01-01T00:00:00Z" }),
      project({ id: "undated-b", name: "B" }),
      project({ id: "later", name: "Later", targetDate: "2026-12-01T00:00:00Z" }),
      project({ id: "soon", name: "Soon", targetDate: "2026-11-15T00:00:00Z" }),
      project({ id: "undated-a", name: "A" }),
    ]);
    expect(sorted.map((p) => p.id)).toEqual(["soon", "later", "undated-a", "undated-b", "done"]);
  });
  it("does not mutate its input", () => {
    const input = [project({ id: "b", name: "B" }), project({ id: "a", name: "A" })];
    sortProjects(input);
    expect(input.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("portfolioTotals", () => {
  it("sums open, in progress, done and errors, and ignores canceled", () => {
    const t = portfolioTotals([
      project({ counts: { triage: 1, backlog: 2, todo: 3, in_progress: 4, in_review: 1, done: 5, canceled: 9, duplicate: 9 }, errors: { ...noErrors, mapped: true, openCount: 2 } }),
      project({ counts: { todo: 1, done: 1 }, errors: { ...noErrors, mapped: true, openCount: 3 } }),
    ]);
    expect(t).toEqual({ projects: 2, open: 7, inProgress: 5, done: 6, errors: 5 });
  });
  it("is zero for no projects", () => {
    expect(portfolioTotals([])).toEqual({ projects: 0, open: 0, inProgress: 0, done: 0, errors: 0 });
  });
});

describe("errorChip", () => {
  const mapped = (over: Partial<PortfolioErrors>): PortfolioErrors => ({ ...noErrors, mapped: true, status: "ok", lastSyncedAt: "2026-11-09T00:00:00Z", ...over });
  it("says so when the project is not linked", () => {
    expect(errorChip(noErrors).label).toBe("No error tracking");
  });
  it("says not synced when nothing has been read", () => {
    expect(errorChip(mapped({ status: null, lastSyncedAt: null })).label).toBe("Not synced yet");
  });
  it("reads healthy, open, capped and singular counts in words", () => {
    expect(errorChip(mapped({}))).toMatchObject({ label: "No open errors", tone: "text-healthy" });
    expect(errorChip(mapped({ openCount: 1 })).label).toBe("1 open error");
    expect(errorChip(mapped({ openCount: 7 })).label).toBe("7 open errors");
    expect(errorChip(mapped({ openCount: 100, openCapped: true })).label).toBe("100+ open errors");
  });
  it("marks stale or troubled counts as last known and never calls them healthy", () => {
    expect(errorChip(mapped({ stale: true })).label).toBe("No open errors (last known)");
    expect(errorChip(mapped({ status: "unreachable" })).tone).toBe("text-attention");
    expect(errorChip(mapped({ status: "auth_failed", openCount: 4 })).label).toBe("4 open errors (last known)");
  });
});

describe("activityText", () => {
  it("names the actor, and falls back to the action alone", () => {
    expect(activityText({ action: "state_changed", actorName: "Sam", actorType: "human" })).toBe("state changed by Sam");
    expect(activityText({ action: "issue.created", actorName: null, actorType: "human" })).toBe("issue created");
    expect(activityText({ action: "triaged", actorName: null, actorType: "system" })).toBe("triaged by system");
  });
});

describe("nextRowIndex", () => {
  it("moves with j/k and the arrows, clamps at both ends, and starts at the first row", () => {
    expect(nextRowIndex(-1, "j", 3)).toBe(0);
    expect(nextRowIndex(-1, "ArrowUp", 3)).toBe(0);
    expect(nextRowIndex(0, "j", 3)).toBe(1);
    expect(nextRowIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextRowIndex(0, "k", 3)).toBe(0);
    expect(nextRowIndex(2, "k", 3)).toBe(1);
    expect(nextRowIndex(1, "Home", 3)).toBe(0);
    expect(nextRowIndex(1, "End", 3)).toBe(2);
  });
  it("leaves other keys and an empty list alone", () => {
    expect(nextRowIndex(1, "x", 3)).toBe(1);
    expect(nextRowIndex(0, "j", 0)).toBe(-1);
  });
});

describe("landing", () => {
  it("is the overview, and the post-login default", () => {
    expect(DEFAULT_LANDING).toBe("/overview");
    expect(safeReturnTo(null)).toBe("/overview");
    expect(safeReturnTo("//evil.example")).toBe("/overview");
    expect(safeReturnTo("/board")).toBe("/board");
  });
});
