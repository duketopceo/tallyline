import { describe, expect, it } from "vitest";
import { HEALTH_META, UPDATE_HEALTH, updateAuthor } from "./project-updates";
import type { ActorDirectory } from "./actors";

const dir: ActorDirectory = {
  h1: { id: "h1", name: "Luke", kind: "human", initials: "LU" },
  a1: { id: "a1", name: "scribe", kind: "agent", initials: "SC" },
};

describe("updateAuthor", () => {
  it("names a human author without the agent marker", () => {
    expect(updateAuthor({ authorType: "human", authorId: "h1" }, dir)).toEqual({ name: "Luke", isAgent: false });
  });
  it("marks an agent-authored update", () => {
    expect(updateAuthor({ authorType: "agent", authorId: "a1" }, dir)).toEqual({ name: "scribe", isAgent: true });
  });
  it("keeps the agent marker when the agent is no longer in the directory", () => {
    expect(updateAuthor({ authorType: "agent", authorId: "gone" }, dir)).toEqual({ name: "Unknown", isAgent: true });
  });
  it("labels system updates", () => {
    expect(updateAuthor({ authorType: "system", authorId: null }, dir).name).toBe("System");
  });
});

describe("HEALTH_META", () => {
  it("has a text label for every health value", () => {
    for (const h of UPDATE_HEALTH) expect(HEALTH_META[h].label.length).toBeGreaterThan(0);
  });
});
