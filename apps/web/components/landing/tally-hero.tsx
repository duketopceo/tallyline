"use client";

import { useEffect, useRef, useState } from "react";
import { TallyMark } from "@/components/tally-mark";

// The landing hero. The server renders the static brand mark, so the page is
// complete without JavaScript, WebGL or motion. After first paint, when motion
// is allowed, the three.js scene is loaded in its own chunk and fades in over
// the mark. data-hero reports which state the visitor is in:
//   static    server render / reduced motion / waiting for idle
//   loading   the scene chunk is being fetched
//   live      the canvas is mounted
//   fallback  WebGL or a token was unavailable; the static mark stays
type HeroState = "static" | "loading" | "live" | "fallback";

export function TallyHero() {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HeroState>("static");

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) return; // motion is not wanted: never fetch the scene

    let cancelled = false;
    let dispose: (() => void) | undefined;
    let refresh: (() => void) | undefined;

    const start = () => {
      if (cancelled) return;
      setState("loading");
      import("@/lib/landing-hero-scene")
        .then(({ mountHeroScene }) => {
          if (cancelled) return;
          const handle = mountHeroScene(el);
          if (!handle) return setState("fallback");
          dispose = handle.dispose;
          refresh = handle.refreshColors;
          setState("live");
        })
        .catch(() => !cancelled && setState("fallback"));
    };

    // after first paint, off the critical path
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(start, { timeout: 1500 })
      : window.setTimeout(start, 400);

    // theme changes: OS scheme, or an explicit data-theme on <html>
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => refresh?.();
    scheme.addEventListener("change", onScheme);
    const mo = new MutationObserver(onScheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    // if the visitor turns reduced motion on mid-visit, drop back to the static mark
    const onMotion = () => {
      if (!mq.matches) return;
      dispose?.();
      dispose = undefined;
      setState("static");
    };
    mq.addEventListener("change", onMotion);

    return () => {
      cancelled = true;
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      scheme.removeEventListener("change", onScheme);
      mq.removeEventListener("change", onMotion);
      mo.disconnect();
      dispose?.();
    };
  }, []);

  return (
    <div ref={host} data-hero={state} aria-hidden className="relative mx-auto aspect-square w-full max-w-[360px]">
      <div className={`absolute inset-[10%] transition-opacity duration-150 motion-reduce:transition-none ${state === "live" ? "opacity-0" : "opacity-100"}`}>
        <TallyMark fluid />
      </div>
    </div>
  );
}
