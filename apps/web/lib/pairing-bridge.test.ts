import { describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/proxy", () => ({ proxy }));

import { POST } from "../app/api/settings/devices/pairing/route";

describe("phone pairing bridge", () => {
  it("forwards the request to the active workspace's pairing API", () => {
    const req = new Request("https://tallyline.example/api/settings/devices/pairing", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    POST(req);
    expect(proxy).toHaveBeenCalledWith(req, "/devices/pairing");
  });
});
