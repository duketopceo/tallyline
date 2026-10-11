"use client";

import { useEffect, useState } from "react";

type Mode = "system" | "dark" | "light";
const NEXT: Record<Mode, Mode> = { system: "dark", dark: "light", light: "system" };
const LABEL: Record<Mode, string> = { system: "System", dark: "Dark", light: "Light" };

export function applyTheme(mode: Mode) {
  const el = document.documentElement;
  el.classList.remove("system", "dark", "light");
  el.classList.add(mode);
  document.cookie = `tl_theme=${mode}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

// Theme switches apply instantly (no reload) and persist per device in a
// cookie the root layout reads, so the first paint already has the right class.
export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    const c = document.documentElement.classList;
    setMode(c.contains("light") ? "light" : c.contains("dark") ? "dark" : "system");
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        const n = NEXT[mode];
        setMode(n);
        applyTheme(n);
      }}
      title={`Theme: ${LABEL[mode]} (click to change)`}
      aria-label={`Theme: ${LABEL[mode]}. Change theme`}
      className="h-8 rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink"
    >
      {compact ? LABEL[mode][0] : LABEL[mode]}
    </button>
  );
}
