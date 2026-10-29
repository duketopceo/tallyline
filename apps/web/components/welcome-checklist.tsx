"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { progress, type Step } from "@/lib/setup-checklist";

const MARK: Record<Step["state"], { glyph: string; label: string; cls: string }> = {
  done: { glyph: "✓", label: "Done", cls: "text-accent" },
  attention: { glyph: "!", label: "Needs attention", cls: "text-attention" },
  todo: { glyph: "○", label: "To do", cls: "text-ink-subtle" },
};

// Skippable and resumable: the steps are recomputed from the server on every
// visit, so leaving halfway loses nothing. Dismissing only hides the "all set"
// banner on this browser.
export function WelcomeChecklist({
  steps,
  workspace,
  heading,
}: {
  steps: Step[];
  workspace: string;
  heading: string;
}) {
  const key = `tly-welcome-dismissed:${workspace}`;
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(window.localStorage.getItem(key) === "1");
  }, [key]);
  const p = progress(steps);

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      <h2 className="text-[15px] font-semibold">{heading}</h2>
      <p className="mt-1 text-[13px] text-ink-subtle">
        {p.allSet
          ? "Everything required is in place."
          : `${p.done} of ${p.required} required steps done. You can leave and come back; this list always shows where things stand.`}
      </p>
      {p.allSet && !dismissed && (
        <div className="mt-3 flex items-center justify-between rounded-md border border-lining bg-surface-1 p-3 text-[13px]" role="status">
          <span>You're all set. Optional steps below are up to you.</span>
          <button
            type="button"
            onClick={() => {
              window.localStorage.setItem(key, "1");
              setDismissed(true);
            }}
            className="h-7 rounded-sm border border-lining px-3 text-[13px] font-medium"
          >
            Dismiss
          </button>
        </div>
      )}
      <ol className="mt-4 divide-y divide-lining-faint rounded-md border border-lining bg-surface-1">
        {steps.map((s) => {
          const m = MARK[s.state];
          return (
            <li key={s.id} className="flex items-start gap-3 p-3">
              <span aria-hidden className={`mt-0.5 w-4 shrink-0 text-center font-mono text-[13px] ${m.cls}`}>
                {m.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">
                  {s.title}
                  <span className="sr-only"> — {m.label}</span>
                  {s.optional && <span className="ml-2 text-[11px] font-normal text-ink-subtle">optional</span>}
                </p>
                <p className="mt-0.5 text-[13px] text-ink-subtle">{s.detail}</p>
              </div>
              {s.href && s.action && s.state !== "done" && (
                <Link
                  href={s.href}
                  className="h-7 shrink-0 rounded-sm border border-lining px-3 text-[13px] font-medium leading-7 hover:bg-surface-2"
                >
                  {s.action}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
