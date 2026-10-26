import { describe, expect, it } from "vitest";
import { buildConfigBody, revealFrom, rowsFromMap } from "./glitchtip-form";

describe("glitchtip form helpers", () => {
  it("lowercases names, uppercases team keys and drops blank rows", () => {
    const r = buildConfigBody(
      [
        { name: " Portal-UI ", team: "pace" },
        { name: "", team: "" },
        { name: "Wisp", team: "wisp" },
      ],
      " ops ",
    );
    expect(r).toEqual({
      ok: true,
      body: { projectMap: { "portal-ui": "PACE", wisp: "WISP" }, defaultTeamKey: "OPS" },
    });
  });

  it("an empty default becomes null", () => {
    expect(buildConfigBody([], "")).toEqual({
      ok: true,
      body: { projectMap: {}, defaultTeamKey: null },
    });
  });

  it("rejects half-filled and duplicate rows", () => {
    expect(buildConfigBody([{ name: "strut", team: "" }], "").ok).toBe(false);
    expect(buildConfigBody([{ name: "", team: "PACE" }], "").ok).toBe(false);
    const dup = buildConfigBody(
      [{ name: "Strut", team: "PACE" }, { name: "strut", team: "WISP" }],
      "",
    );
    expect(dup).toMatchObject({ ok: false });
  });

  it("round-trips a stored map into sorted rows", () => {
    expect(rowsFromMap({ wisp: "WISP", relay: "PACE" })).toEqual([
      { name: "relay", team: "PACE" },
      { name: "wisp", team: "WISP" },
    ]);
    expect(rowsFromMap(undefined)).toEqual([]);
  });

  it("reveals the URL only when the response carries one", () => {
    expect(revealFrom({ webhookUrl: "https://x/webhooks/glitchtip/tly_gt_a" })).toEqual({
      webhookUrl: "https://x/webhooks/glitchtip/tly_gt_a",
    });
    expect(revealFrom({ integration: {} })).toBeNull();
    expect(revealFrom(null)).toBeNull();
  });
});
