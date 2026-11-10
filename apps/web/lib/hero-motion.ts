// Motion model for the landing hero. Automatic drift lasts AUTOPLAY_S seconds and
// eases out, so self-moving content stops inside 5s (WCAG 2.2.2) and the page
// stops rendering frames when nobody touches it. Pointer lean is user-driven and
// may restart the loop at any time; it stops again once the mark has settled.

export const AUTOPLAY_S = 4.5;
const FADE_S = 1.5;
const EASE = 0.06;
// remaining distance (radians) below which the mark snaps to target and the loop rests
const REST = 5e-4;

export interface Rotation {
  x: number;
  y: number;
}

/** Weight of the automatic drift at time t (seconds since mount): 1, eased to 0 by AUTOPLAY_S. */
export function driftWeight(t: number): number {
  const start = AUTOPLAY_S - FADE_S;
  if (t <= start) return 1;
  if (t >= AUTOPLAY_S) return 0;
  const u = (AUTOPLAY_S - t) / FADE_S;
  return u * u * (3 - 2 * u);
}

/** One frame: ease the rotation toward the target and say whether another frame is needed. */
export function heroStep(t: number, rot: Rotation, pointer: Rotation): { rotation: Rotation; animating: boolean } {
  const w = driftWeight(t);
  const target = {
    y: pointer.x * 0.35 + Math.sin(t * 0.35) * 0.18 * w,
    x: pointer.y * 0.2 + Math.cos(t * 0.27) * 0.06 * w,
  };
  const dy = target.y - rot.y;
  const dx = target.x - rot.x;
  if (w === 0 && Math.abs(dx) < REST && Math.abs(dy) < REST) {
    return { rotation: target, animating: false };
  }
  return { rotation: { x: rot.x + dx * EASE, y: rot.y + dy * EASE }, animating: true };
}
