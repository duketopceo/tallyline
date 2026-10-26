"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// g-sequences — `g i` my issues, `g n` inbox, `g t` triage, `g r` review,
// `g b` board, `g c` cycle, `g a` all issues, `g e` activity, `g p` roadmap, `g o` projects.
// Mirrors the sidebar hints.
const GOTO: Record<string, string> = {
  i: "/my-issues",
  n: "/notifications",
  t: "/triage",
  r: "/review",
  b: "/board",
  c: "/cycle",
  a: "/issues",
  s: "/insights",
  e: "/activity",
  p: "/roadmap",
  o: "/projects",
  ",": "/settings/members",
};

const SEQUENCE_TIMEOUT_MS = 800;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export function GlobalNav() {
  const router = useRouter();

  useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout>;

    function onKey(e: KeyboardEvent) {
      if (
        e.defaultPrevented ||
        isTypingTarget(e.target) ||
        e.metaKey ||
        e.ctrlKey ||
        e.altKey
      ) {
        armed = false;
        return;
      }
      if (armed) {
        armed = false;
        const path = GOTO[e.key];
        if (path) {
          // capture phase: consume before page-level handlers can act on the
          // second key (e.g. `g a` on triage must not also accept the issue)
          e.preventDefault();
          e.stopPropagation();
          router.push(path);
          return;
        }
        // not a route key — disarm and let it through (e.g. `g` then `x` still
        // selects on list pages)
        if (e.key !== "g") return;
      }
      if (e.key === "g") {
        armed = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          armed = false;
        }, SEQUENCE_TIMEOUT_MS);
      }
    }
    // capture so the sequence resolves before per-page key handlers
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [router]);

  return null;
}
