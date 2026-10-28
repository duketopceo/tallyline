import { describe, expect, it } from "vitest";
import {
  countIssues,
  findRoadmapIssue,
  recentProjectEvents,
  reposForProject,
  type HealthEvent,
  type HealthIssue,
} from "./project-health";

const issue = (
  key: string,
  state: HealthIssue["state"],
  parentId: string | null = null,
): HealthIssue => ({ id: `id-${key}`, key, title: key, state, parentId });

describe("countIssues", () => {
  it("buckets states and ignores canceled/duplicate", () => {
    const counts = countIssues([
      issue("A-1", "triage"),
      issue("A-2", "backlog"),
      issue("A-3", "todo"),
      issue("A-4", "in_progress"),
      issue("A-5", "in_review"),
      issue("A-6", "done"),
      issue("A-7", "canceled"),
      issue("A-8", "duplicate"),
    ]);
    expect(counts).toEqual({ open: 3, inProgress: 2, done: 1 });
  });
});

describe("findRoadmapIssue", () => {
  it("picks the top-level issue with the most children", () => {
    const issues = [
      issue("A-1", "todo"),
      issue("A-2", "todo"),
      issue("A-3", "todo", "id-A-2"),
      issue("A-4", "todo", "id-A-2"),
      issue("A-5", "todo", "id-A-1"),
    ];
    expect(findRoadmapIssue(issues)?.key).toBe("A-2");
  });

  it("returns null when nothing is a parent, and ignores nested parents", () => {
    expect(findRoadmapIssue([issue("A-1", "todo")])).toBeNull();
    const nested = [
      issue("A-1", "todo"),
      issue("A-2", "todo", "id-A-1"),
      issue("A-3", "todo", "id-A-2"),
    ];
    expect(findRoadmapIssue(nested)?.key).toBe("A-1");
  });
});

describe("recentProjectEvents", () => {
  it("keeps only the project's issue keys, newest first, capped", () => {
    const ev = (id: string, issueKey: string | null): HealthEvent => ({
      id,
      action: "issue.updated",
      actorName: null,
      issueKey,
      issueTitle: null,
      createdAt: "2026-10-26T00:00:00Z",
    });
    const out = recentProjectEvents(
      [ev("1", "A-1"), ev("2", "B-1"), ev("3", null), ev("4", "A-1"), ev("5", "A-1")],
      [issue("A-1", "todo")],
      2,
    );
    expect(out.map((e) => e.id)).toEqual(["1", "4"]);
  });
});

describe("reposForProject", () => {
  it("filters by projectId", () => {
    const repos = [
      { id: "r1", fullName: "o/a", projectId: "p1" },
      { id: "r2", fullName: "o/b", projectId: null },
      { id: "r3", fullName: "o/c" },
    ];
    expect(reposForProject(repos, "p1").map((r) => r.id)).toEqual(["r1"]);
  });
});
