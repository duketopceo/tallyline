"use client";

import { useRouter } from "next/navigation";
import { useRegisterActions } from "./actions";
import { applyTheme } from "./theme-toggle";

const NAV: [string, string, string, string][] = [
  ["nav-my", "My issues", "/my-issues", "g i"],
  ["nav-triage", "Triage", "/triage", "g t"],
  ["nav-review", "Review queue", "/review", "g r"],
  ["nav-board", "Board", "/board", "g b"],
  ["nav-cycle", "Cycles", "/cycle", "g c"],
  ["nav-issues", "All issues", "/issues", "g a"],
  ["nav-insights", "Insights", "/insights", "g s"],
  ["nav-roadmap", "Roadmap", "/roadmap", "g p"],
  ["nav-activity", "Activity", "/activity", "g e"],
];

export function GlobalActions() {
  const router = useRouter();
  useRegisterActions(
    "global",
    [
      ...NAV.map(([id, label, , keys]) => ({ id, label: `Go to ${label}`, group: "Navigate", keys })),
      { id: "create", label: "Create issue", group: "Create", keys: "c" },
      { id: "theme-dark", label: "Theme: dark", group: "View" },
      { id: "theme-light", label: "Theme: light", group: "View" },
      { id: "theme-system", label: "Theme: follow system", group: "View" },
      { id: "undo", label: "Undo last change", group: "Edit", keys: "⌘Z" },
      { id: "signout", label: "Sign out", group: "Account" },
    ],
    (id) => {
      const nav = NAV.find((n) => n[0] === id);
      if (nav) return router.push(nav[2]);
      if (id === "create") setTimeout(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" })), 0);
      else if (id.startsWith("theme-")) applyTheme(id.slice(6) as "dark" | "light" | "system");
      else if (id === "undo") document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true }));
      else if (id === "signout") void fetch("/api/logout", { method: "POST" }).then(() => { window.location.href = "/login"; });
    },
  );
  return null;
}
