import { describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", () => ({ proxy }));

import { POST as createWorkspace } from "../app/api/workspaces/route";
import { POST as createTeam } from "../app/api/teams/route";

describe("review workspace bridges", () => {
  it("creates a workspace through the human session without active-workspace scoping", () => {
    const req = new Request("https://tallyline.example/api/workspaces", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ slug: "review", name: "App Review" }),
    });
    createWorkspace(req);
    expect(proxy).toHaveBeenCalledWith(req, "/workspaces", { workspace: false });
  });

  it("creates a team in the active workspace through the human session", () => {
    const req = new Request("https://tallyline.example/api/teams", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ key: "REV", name: "Review" }),
    });
    createTeam(req);
    expect(proxy).toHaveBeenCalledWith(req, "/teams");
  });
});
