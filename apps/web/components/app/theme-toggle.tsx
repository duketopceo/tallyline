"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { type Appearance, THEME_LABELS } from "@tallyline/silver-lining";
import { applyAppearance } from "@/lib/appearance-client";
import { resolvedMode } from "@/lib/appearance";
import { IconMonitor, IconMoon, IconSun } from "./icons";

type Mode = "system" | "light" | "dark";

const CHOICES: { mode: Mode; label: string; Icon: typeof IconSun }[] = [
  { mode: "system", label: "System", Icon: IconMonitor },
  { mode: "light", label: "Light", Icon: IconSun },
  { mode: "dark", label: "Dark", Icon: IconMoon },
];

// Palette quick-switch (command "Theme: ..."). Full control (high contrast,
// custom) lives in Settings > Appearance; every writer shares applyAppearance.
export function applyTheme(mode: Mode) {
  applyAppearance({ theme: mode });
}

function describe(a: Appearance): string {
  if (a.theme === "system") return "System";
  if (a.theme === "custom") return "Custom";
  return THEME_LABELS[a.theme];
}

/**
 * Theme control for the shell chrome (sidebar footer, rail, mobile drawer).
 * Popover with System, Light, Dark and a link to Appearance settings. When
 * high contrast or a custom theme is active the trigger shows that state and
 * choosing a mode replaces it.
 */
export function ThemeToggle({ initial, rail }: { initial: Appearance; rail: boolean }) {
  const [appearance, setAppearance] = useState<Appearance>(initial);
  const [open, setOpen] = useState(false);
  const [osLight, setOsLight] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const sync = () => setOsLight(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    const onChange = (e: Event) => setAppearance((e as CustomEvent<Appearance>).detail);
    document.addEventListener("sl-appearance", onChange);
    return () => {
      mq.removeEventListener("change", sync);
      document.removeEventListener("sl-appearance", onChange);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const mode = resolvedMode(appearance, osLight);
  const Icon =
    appearance.theme === "system" ? IconMonitor : mode === "light" ? IconSun : IconMoon;
  const state = describe(appearance);
  const active: Mode | null =
    appearance.theme === "system" || appearance.theme === "light" || appearance.theme === "dark"
      ? appearance.theme
      : null;

  const choose = (m: Mode) => {
    applyTheme(m);
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div
      ref={root}
      className="relative"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // keep the mobile drawer's own Escape handler from also firing
          e.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Theme: ${state}`}
        title={`Theme: ${state}`}
        data-testid="theme-toggle"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-sm px-2 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
      >
        <Icon size={16} aria-hidden className="shrink-0" />
        {!rail && <span>{state}</span>}
      </button>
      {open && (
        <div
          role="group"
          aria-label="Theme"
          data-testid="theme-popover"
          className={`absolute z-50 w-44 rounded-md border border-lining bg-surface-2 p-1 shadow-none ${rail ? "bottom-0 left-full ml-2" : "bottom-full left-0 mb-1"}`}
        >
          {CHOICES.map(({ mode: m, label, Icon: ChoiceIcon }) => (
            <button
              key={m}
              type="button"
              aria-pressed={active === m}
              onClick={() => choose(m)}
              className={`flex h-8 w-full items-center gap-2 rounded-sm px-2 text-xs ${active === m ? "bg-surface-3 text-ink" : "text-ink-muted hover:bg-surface-3 hover:text-ink"}`}
            >
              <ChoiceIcon size={16} aria-hidden className="shrink-0" />
              <span>{label}</span>
              {active === m && <span className="sr-only">(current)</span>}
            </button>
          ))}
          <hr className="my-1 border-lining-faint" />
          <Link
            href="/settings/appearance"
            onClick={() => setOpen(false)}
            className="flex h-8 items-center rounded-sm px-2 text-xs text-ink-subtle hover:bg-surface-3 hover:text-ink"
          >
            Appearance settings
          </Link>
        </div>
      )}
    </div>
  );
}
