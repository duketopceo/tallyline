import { describe, expect, it } from "vitest";
import {
  applyLiveEvent,
  EMPTY_SUMMARY,
  isShipEvent,
  milestoneStatus,
  relAgo,
  ringShare,
  windowStart,
  type LiveFeedEvent,
  type RoadmapSummary,
} from "./roadmap-pulse";

const NOW = Date.UTC(2026, 9, 28, 6, 30);
const DAY = 86_400_000;

describe("ringShare", () => {
  it("splits closed and in-flight, and never overflows the ring", () => {
    expect(ringShare({ total: 24, closed: 9, inProgress: 4, inReview: 2 })).toEqual({ done: 37.5, active: 25, percent: 37 });
    const over = ringShare({ total: 4, closed: 3, inProgress: 5, inReview: 5 });
    expect(over.done + over.active).toBeLessThanOrEqual(100);
  });
  it("is empty for a project with no issues", () => {
    expect(ringShare({ total: 0, closed: 0, inProgress: 0, inReview: 0 })).toEqual({ done: 0, active: 0, percent: 0 });
  });
  it("floors the percent so 99.9% never reads 100", () => {
    expect(ringShare({ total: 1000, closed: 999, inProgress: 0, inReview: 0 }).percent).toBe(99);
  });
});

describe("milestoneStatus", () => {
  const at = (d: number) => new Date(NOW + d * DAY).toISOString();
  it("reads done, late, soon, ahead and undated", () => {
    expect(milestoneStatus({ done: true, targetDate: at(-9) }, NOW).tone).toBe("done");
    expect(milestoneStatus({ done: false, targetDate: at(-2.5) }, NOW)).toMatchObject({ tone: "late", label: "2d late", glyph: "!" });
    expect(milestoneStatus({ done: false, targetDate: at(2) }, NOW)).toMatchObject({ tone: "soon", label: "2d left", glyph: "▲" });
    expect(milestoneStatus({ done: false, targetDate: at(30) }, NOW)).toMatchObject({ tone: "ahead", label: "30d left", glyph: "◆" });
    expect(milestoneStatus({ done: false, targetDate: null }, NOW).tone).toBe("undated");
  });
  it("a target later today is due today, not late", () => {
    expect(milestoneStatus({ done: false, targetDate: new Date(NOW).toISOString() }, NOW).label).toBe("due today");
  });
});

describe("windowStart", () => {
  it("rolls 24h and 7d from now", () => {
    expect(windowStart("24h", NOW)).toBe(NOW - DAY);
    expect(windowStart("7d", NOW)).toBe(NOW - 7 * DAY);
  });
  it("today is local midnight, never in the future", () => {
    const t = windowStart("today", NOW);
    expect(t).toBeLessThanOrEqual(NOW);
    expect(NOW - t).toBeLessThan(DAY);
    expect(new Date(t).getHours()).toBe(0);
  });
});

describe("relAgo", () => {
  it("is now, minutes, hours, days", () => {
    const iso = (ms: number) => new Date(NOW - ms).toISOString();
    expect(relAgo(iso(10_000), NOW)).toBe("now");
    expect(relAgo(iso(5 * 60_000), NOW)).toBe("5m");
    expect(relAgo(iso(3 * 3_600_000), NOW)).toBe("3h");
    expect(relAgo(iso(72 * 3_600_000), NOW)).toBe("3d");
  });
});

const base: RoadmapSummary = {
  ...EMPTY_SUMMARY,
  totals: { issues: 10, done: 2, closed: 2, doneSince: 1 },
  projects: [{ projectId: "p1", total: 10, done: 2, closed: 2, inProgress: 3, inReview: 1, byState: {}, doneSince: 1, recent: [] }],
};
const ev = (over: Partial<LiveFeedEvent>): LiveFeedEvent => ({
  id: "100",
  entityType: "issue",
  action: "state_changed",
  actorType: "human",
  actorName: "Luke",
  issueKey: "TLY-9",
  issueTitle: "ring it",
  projectId: "p1",
  before: { state: "in_review" },
  after: { state: "done" },
  createdAt: new Date(NOW).toISOString(),
  ...over,
});

describe("applyLiveEvent", () => {
  it("a move to done bumps the ring, totals and the ticker", () => {
    const s = applyLiveEvent(base, ev({}), NOW - DAY);
    expect(s.projects[0]).toMatchObject({ done: 3, closed: 3, doneSince: 2, inReview: 0, inProgress: 3 });
    expect(s.totals).toMatchObject({ done: 3, doneSince: 2 });
    expect(s.merges[0]).toMatchObject({ issueKey: "TLY-9", actorName: "Luke", pr: null });
  });
  it("a PR merge for the same ticket enriches its item without double counting", () => {
    const once = applyLiveEvent(base, ev({}), NOW - DAY);
    const twice = applyLiveEvent(
      once,
      ev({ id: "101", action: "pr_merged", actorType: "system", actorName: null, before: null, after: { pr: 7, url: "https://github.com/x/y/pull/7", title: "t (TLY-9)", author: "octocat", repo: "x/y" } }),
      NOW - DAY,
    );
    expect(twice.merges).toHaveLength(1);
    expect(twice.merges[0]).toMatchObject({ actorName: "Luke", pr: { number: 7, url: "https://github.com/x/y/pull/7" } });
    expect(twice.projects[0]!.done).toBe(3);
  });
  it("a PR merge alone shows the author and leaves the counts alone", () => {
    const pr = applyLiveEvent(base, ev({ action: "pr_merged", actorType: "system", actorName: null, before: null, after: { pr: 7, url: "u", author: "octocat" } }), NOW - DAY);
    expect(pr.merges[0]!.actorName).toBe("octocat");
    expect(pr.projects[0]!.done).toBe(2);
  });
  it("ignores events outside the window, non-ship events and repeats of done", () => {
    expect(applyLiveEvent(base, ev({ createdAt: new Date(NOW - 3 * DAY).toISOString() }), NOW - DAY)).toBe(base);
    expect(applyLiveEvent(base, ev({ after: { state: "in_progress" } }), NOW - DAY)).toBe(base);
    expect(applyLiveEvent(base, ev({ before: { state: "done" } }), NOW - DAY)).toBe(base);
    expect(isShipEvent(ev({ entityType: "comment" }))).toBe(false);
  });
});
