"use client";
import { useEffect, useState } from "react";

// Rebuilt-board loop for the landing hero — DOM props on real tokens, canned
// demo issues (never a capture). One card travels triage → in_review while
// column counts tick and the glint claims it. Reduced-motion freezes mid-loop.

const COLS = [
  { key: "triage", label: "Triage" },
  { key: "todo", label: "Todo" },
  { key: "progress", label: "In progress" },
  { key: "review", label: "In review" },
] as const;

type ColKey = (typeof COLS)[number]["key"];

const FILLERS: Record<ColKey, { k: string; t: string; who?: string }[]> = {
  triage: [
    { k: "TLY-57", t: "SSE reconnect drops queued updates" },
    { k: "TLY-58", t: "Keymap overlay traps ⌘K" },
  ],
  todo: [
    { k: "TLY-44", t: "Agent keys list omits expiry", who: "LK" },
    { k: "TLY-49", t: "Peek panel scrolls board on open" },
  ],
  progress: [
    { k: "TLY-36", t: "MCP claim returns stale assignee", who: "glint" },
    { k: "TLY-39", t: "Undo toast covers last row", who: "DR" },
  ],
  review: [
    { k: "TLY-31", t: "Intake badge wraps at 13px", who: "glint" },
    { k: "TLY-33", t: "Duplicate link suggests wrong issue" },
  ],
};

// step = which column the hero card occupies
const ORDER: ColKey[] = ["triage", "todo", "progress", "review"];
const STEP_MS = 2400;
const HOLD_MS = 2600;

const BASE: Record<ColKey, number> = { triage: 2, todo: 2, progress: 2, review: 2 };

function GlintMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" className="inline shrink-0 fill-accent" aria-hidden>
      <path d="M12 1l2.6 7.4L22 11l-7.4 2.6L12 21l-2.6-7.4L2 11l7.4-2.6Z" />
    </svg>
  );
}

function Card({ k, t, who, hero, step }: { k: string; t: string; who?: string | undefined; hero?: boolean | undefined; step: number }) {
  return (
    <div
      key={hero ? `hero-${step}` : k}
      className={`rounded-sm border bg-surface-1 px-2 py-1.5 text-left ${
        hero ? "border-accent/60 shadow-[0_0_0_1px_var(--color-accent)] bl-deal" : "border-lining"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] text-ink-subtle">{k}</span>
        {who === "glint" && <GlintMark />}
        {who && who !== "glint" && (
          <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-surface-3 text-[8px] font-medium text-ink-muted">{who}</span>
        )}
      </div>
      <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink">{t}</p>
      {hero && step === 0 && (
        <span className="bl-flash mt-1 inline-flex items-center gap-1 rounded-full border border-lining-strong bg-surface-2 px-1.5 py-px text-[9px] text-ink-muted">
          <GlintMark /> accept
        </span>
      )}
      {hero && step >= 2 && (
        <span className="bl-flash mt-1 inline-flex items-center gap-1 rounded-full border border-lining-strong bg-surface-2 px-1.5 py-px text-[9px] text-ink-muted">
          <GlintMark /> agent working
        </span>
      )}
    </div>
  );
}

export function BoardLoop() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setStep(3);
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    let cur = 0;
    const advance = () => {
      cur = (cur + 1) % ORDER.length;
      setStep(cur);
      t = setTimeout(advance, cur === ORDER.length - 1 ? HOLD_MS : STEP_MS);
    };
    t = setTimeout(advance, STEP_MS);
    return () => clearTimeout(t);
  }, []);

  const here = ORDER[step]!;
  return (
    <div className="overflow-hidden rounded-lg border border-lining-strong bg-surface-1">
      <div aria-hidden className="flex h-7 items-center gap-1.5 border-b border-lining bg-surface-2 px-3">
        <span className="h-2 w-2 rounded-full bg-lining-strong" />
        <span className="h-2 w-2 rounded-full bg-lining-strong" />
        <span className="h-2 w-2 rounded-full bg-lining-strong" />
        <span className="ml-3 font-mono text-[10px] text-ink-subtle">tallyline · board</span>
      </div>
      <style>{`
        .bl-deal { animation: bl-deal 550ms cubic-bezier(.2,.9,.25,1); }
        @keyframes bl-deal { from { opacity: 0; transform: translateX(-14px); } to { opacity: 1; transform: none; } }
        .bl-flash { animation: bl-flash 800ms ease-out; }
        @keyframes bl-flash { from { opacity: 0; } to { opacity: 1; } }
        @media (prefers-reduced-motion: reduce) { .bl-deal, .bl-flash { animation: none; } }
      `}</style>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-4" role="img" aria-label="Demo board: a card moves from triage to in review while column counts update">
        {COLS.map((col) => {
          const count = BASE[col.key] + (here === col.key ? 1 : 0);
          return (
            <div key={col.key} className="rounded-sm bg-surface-2/60 p-1.5">
              <div className="mb-1.5 flex items-center justify-between px-0.5">
                <span className="text-[10px] font-medium text-ink-muted">{col.label}</span>
                <span key={count} className="bl-flash font-mono text-[10px] text-ink-subtle">{count}</span>
              </div>
              <div className="space-y-1.5">
                {here === col.key && (
                  <Card hero step={step} k="TLY-42" t="Slack intake drops multiline bodies" who={step >= 2 ? "glint" : undefined} />
                )}
                {FILLERS[col.key].map((f) => (
                  <Card key={f.k} k={f.k} t={f.t} who={f.who} step={step} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
