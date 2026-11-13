import { describe, expect, it } from "vitest";
import { AUTOPLAY_S, driftWeight, heroStep } from "./hero-motion";

describe("driftWeight", () => {
  it("is full at mount and zero once the autoplay window ends", () => {
    expect(driftWeight(0)).toBe(1);
    expect(driftWeight(AUTOPLAY_S)).toBe(0);
    expect(driftWeight(AUTOPLAY_S + 60)).toBe(0);
  });
  it("eases down instead of cutting off, so the mark does not jump", () => {
    const mid = driftWeight(AUTOPLAY_S - 0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
  it("ends inside the 5s limit for automatic motion (WCAG 2.2.2)", () => {
    expect(AUTOPLAY_S).toBeLessThanOrEqual(5);
  });
});

describe("heroStep", () => {
  it("keeps animating during the autoplay window", () => {
    expect(heroStep(1, { x: 0, y: 0 }, { x: 0, y: 0 }).animating).toBe(true);
  });

  it("settles and stops after the window with no pointer input", () => {
    let rot = { x: 0.05, y: 0.1 };
    let animating = true;
    let frames = 0;
    for (let t = AUTOPLAY_S; animating && frames < 2000; t += 1 / 60, frames++) {
      const s = heroStep(t, rot, { x: 0, y: 0 });
      rot = s.rotation;
      animating = s.animating;
    }
    expect(animating).toBe(false);
    expect(frames).toBeLessThan(2000);
    expect(Math.abs(rot.x)).toBeLessThan(1e-3);
    expect(Math.abs(rot.y)).toBeLessThan(1e-3);
  });

  it("restarts toward the pointer after the window and stops once it arrives", () => {
    const t = AUTOPLAY_S + 10;
    const first = heroStep(t, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(first.animating).toBe(true);
    expect(first.rotation.y).toBeGreaterThan(0);

    let rot = first.rotation;
    let animating = true;
    let frames = 0;
    for (; animating && frames < 2000; frames++) {
      const s = heroStep(t, rot, { x: 1, y: 1 });
      rot = s.rotation;
      animating = s.animating;
    }
    expect(animating).toBe(false);
    expect(rot.y).toBeCloseTo(0.35, 2);
    expect(rot.x).toBeCloseTo(0.2, 2);
  });
});
