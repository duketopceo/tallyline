"use client";

import {
  type Appearance,
  type CustomTheme,
  DEFAULT_CUSTOM,
  THEME_LABELS,
  type ThemeId,
  contrastRatio,
  themeToStyle,
  generateCustom,
  normalizeCustom,
  tokens,
} from "@tallyline/silver-lining";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { applyAppearance, readStoredCustom } from "@/lib/appearance-client";

// Settings > Appearance. Choosing a theme (or moving a custom slider) applies
// instantly to <html> with no reload and is remembered per device in a cookie
// that the root layout reads, so the next page load paints the same theme.

const THEME_CHOICES: { id: Appearance["theme"]; label: string; hint: string }[] = [
  { id: "system", label: "Follow system", hint: "Dark or light, matching your OS." },
  { id: "dark", label: THEME_LABELS.dark, hint: "Default. Easy on the eyes in long sessions." },
  { id: "light", label: THEME_LABELS.light, hint: "Silver-white canvas." },
  { id: "hc-dark", label: THEME_LABELS["hc-dark"], hint: "Wider text and edge contrast." },
  { id: "custom", label: "Custom", hint: "Your own base, accent and contrast." },
];

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}

function Slider({ label, value, min, max, step, onChange }: SliderProps) {
  return (
    <label className="flex items-center gap-3 text-xs text-ink-subtle">
      <span className="w-28 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-w-0 flex-1 accent-accent"
      />
      <output className="w-12 shrink-0 text-right font-mono text-ink-muted">
        {+value.toFixed(3)}
      </output>
    </label>
  );
}

export function AppearanceSettings({ initial }: { initial: Appearance }) {
  const [theme, setTheme] = useState<Appearance["theme"]>(initial.theme);
  const [custom, setCustom] = useState<CustomTheme>(
    initial.theme === "custom" ? initial.custom : DEFAULT_CUSTOM,
  );

  const appearance: Appearance = useMemo(
    () => (theme === "custom" ? { theme, custom } : { theme }),
    [theme, custom],
  );

  // a custom theme set earlier (before the sidebar toggle switched modes) comes back
  useEffect(() => {
    if (initial.theme === "custom") return;
    const stored = readStoredCustom();
    if (stored) setCustom(stored);
  }, [initial.theme]);

  // apply instantly on every change; skip the very first render (already SSR'd)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    applyAppearance(appearance);
  }, [appearance]);

  const preview = useMemo(() => {
    if (theme === "custom") {
      const g = generateCustom(custom);
      return { mode: g.mode, t: g.tokens };
    }
    const id: ThemeId =
      theme === "system"
        ? typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : theme;
    return { mode: id === "light" ? ("light" as const) : ("dark" as const), t: tokens[id] };
  }, [theme, custom]);

  const style = themeToStyle(preview.t as never, preview.mode) as CSSProperties;
  const ratio = (fg: "ink" | "ink-muted" | "ink-subtle") =>
    contrastRatio(preview.t[fg], preview.t["surface-4"]).toFixed(1);
  const setBase = (patch: Partial<CustomTheme["base"]>) =>
    setCustom((c) => normalizeCustom({ ...c, base: { ...c.base, ...patch } }));
  const setAccent = (patch: Partial<CustomTheme["accent"]>) =>
    setCustom((c) => normalizeCustom({ ...c, accent: { ...c.accent, ...patch } }));

  return (
    <div className="grid min-h-0 flex-1 gap-8 overflow-auto p-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div>
        <fieldset>
          <legend className="text-xs text-ink-subtle">Theme</legend>
          <div className="mt-2 flex flex-col gap-2">
            {THEME_CHOICES.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-start gap-3 rounded-sm border border-lining px-3 py-2 has-[:checked]:border-lining-strong has-[:checked]:bg-surface-1"
              >
                <input
                  type="radio"
                  name="theme"
                  value={c.id}
                  checked={theme === c.id}
                  onChange={() => setTheme(c.id)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="block text-sm text-ink">{c.label}</span>
                  <span className="block text-xs text-ink-subtle">{c.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {theme === "custom" && (
          <fieldset className="mt-6 flex flex-col gap-3">
            <legend className="text-xs text-ink-subtle">Custom theme (OKLCH)</legend>
            <Slider label="Base lightness" min={0} max={1} step={0.005} value={custom.base.l} onChange={(l) => setBase({ l })} />
            <Slider label="Base chroma" min={0} max={0.05} step={0.001} value={custom.base.c} onChange={(c) => setBase({ c })} />
            <Slider label="Base hue" min={0} max={360} step={1} value={custom.base.h} onChange={(h) => setBase({ h })} />
            <Slider label="Accent lightness" min={0.3} max={0.9} step={0.005} value={custom.accent.l} onChange={(l) => setAccent({ l })} />
            <Slider label="Accent chroma" min={0} max={0.25} step={0.005} value={custom.accent.c} onChange={(c) => setAccent({ c })} />
            <Slider label="Accent hue" min={0} max={360} step={1} value={custom.accent.h} onChange={(h) => setAccent({ h })} />
            <Slider label="Contrast" min={0} max={100} step={1} value={custom.contrast} onChange={(contrast) => setCustom((c) => ({ ...c, contrast }))} />
            <p className="text-xs text-ink-subtle">
              Outputs are clamped so text always meets the contrast floors, whatever you pick.
              A dark base gives a dark theme; a light base gives a light one.
            </p>
            <button
              type="button"
              onClick={() => setCustom(DEFAULT_CUSTOM)}
              className="self-start rounded-sm border border-control px-3 py-1.5 text-xs text-ink hover:bg-surface-1"
            >
              Reset custom theme
            </button>
          </fieldset>
        )}
      </div>

      <section aria-label="Theme preview">
        <h2 className="text-xs text-ink-subtle">Preview</h2>
        <div
          style={style}
          className="mt-2 rounded-md border border-lining bg-canvas p-4 text-ink"
          data-testid="appearance-preview"
        >
          <div className="rounded-sm border border-lining bg-surface-1">
            <div className="flex h-9 items-center gap-3 border-b border-lining-faint px-3 text-[13px]">
              <span className="font-mono text-xs text-ink-subtle">TAL-42</span>
              <span className="min-w-0 flex-1 truncate text-ink">Triage the failing nightly run</span>
              <span className="rounded-full border border-attention px-2 py-0.5 font-mono text-[11px] text-attention">
                in progress
              </span>
            </div>
            <div className="flex h-9 items-center gap-3 border-b border-lining-faint bg-surface-2 px-3 text-[13px]">
              <span className="font-mono text-xs text-ink-subtle">TAL-43</span>
              <span className="min-w-0 flex-1 truncate text-ink-muted">Review agent patch for the importer</span>
              <span className="rounded-full border border-accent px-2 py-0.5 font-mono text-[11px] text-accent">
                in review
              </span>
            </div>
            <div className="flex items-center gap-2 p-3">
              <button type="button" className="rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent">
                Approve run
              </button>
              <button type="button" className="rounded-sm border border-control px-3 py-1.5 text-[13px] text-ink">
                Send back
              </button>
              <span className="text-xs text-ink-disabled">Disabled hint</span>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-xs text-ink-subtle">
            <div>
              <dt>Ink on surface-4</dt>
              <dd className="font-mono text-ink">{ratio("ink")}:1</dd>
            </div>
            <div>
              <dt>Muted</dt>
              <dd className="font-mono text-ink">{ratio("ink-muted")}:1</dd>
            </div>
            <div>
              <dt>Subtle</dt>
              <dd className="font-mono text-ink">{ratio("ink-subtle")}:1</dd>
            </div>
          </dl>
        </div>
        <p className="mt-3 text-xs text-ink-subtle">
          Saved on this device. Changes apply immediately; no reload needed.
        </p>
      </section>
    </div>
  );
}
