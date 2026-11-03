import { describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", () => ({ proxy }));

import { POST } from "../app/api/workspaces/route";

describe("workspace creation bridge", () => {
  it("forwards creation through the authenticated session without workspace scoping", () => {
    const req = new Request("https://tallyline.example/api/workspaces", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ slug: "review", name: "App Review" }),
    });
    POST(req);
    expect(proxy).toHaveBeenCalledWith(req, "/workspaces", { workspace: false });
  });
});
