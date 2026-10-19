"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useToast } from "@/components/app/toast";
import type { ListIssue } from "@/components/issue-list-client";
import { PRIORITY_LABEL, STATE_LABEL } from "@/lib/format";

export function PlanNextCycle({
  candidates,
  cycleId,
  cycleLabel,
}: {
  candidates: ListIssue[];
  cycleId: string;
  cycleLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = (key: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  async function assign() {
    if (busy || picked.size === 0) return;
    setBusy(true);
    const keys = [...picked];
    const results = await Promise.all(
      keys.map(async (key) => {
        try {
          const res = await fetch(`/api/issues/${encodeURIComponent(key)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cycleId }),
          });
          return res.ok ? null : key;
        } catch {
          return key;
        }
      }),
    );
    setBusy(false);
    const failed = results.filter((k): k is string => k !== null);
    const ok = keys.length - failed.length;
    if (ok > 0) toast.push({ message: `${ok} ${ok === 1 ? "issue" : "issues"} added to ${cycleLabel}` });
    if (failed.length > 0) toast.push({ error: true, message: `Not assigned: ${failed.join(", ")}` });
    setPicked(new Set(failed));
    router.refresh();
  }

  return (
    <section aria-label="Plan next cycle" className="shrink-0 border-t border-lining-faint">
      <div className="flex items-center gap-3 px-4 py-2">
        <h2 className="text-[13px] font-semibold text-ink">Plan next cycle</h2>
        <span className="text-[12px] text-ink-subtle">{cycleLabel}</span>
        <button
          type="button"
          onClick={() => void assign()}
          disabled={busy || picked.size === 0}
          className="ml-auto rounded-sm bg-accent px-3 py-1 text-[12px] font-medium text-on-accent disabled:opacity-50"
        >
          {busy ? "Assigning" : picked.size > 0 ? `Add ${picked.size} to ${cycleLabel}` : `Add to ${cycleLabel}`}
        </button>
      </div>
      {candidates.length === 0 ? (
        <p className="px-4 pb-3 text-[12px] text-ink-subtle">Nothing in todo or backlog is waiting for a cycle.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-lining-faint overflow-y-auto border-t border-lining-faint">
          {candidates.map((i) => (
            <li key={i.key}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-1.5 hover:bg-surface-2">
                <input
                  type="checkbox"
                  checked={picked.has(i.key)}
                  onChange={() => toggle(i.key)}
                  className="accent-accent"
                />
                <span className="font-mono text-[11px] text-ink-tertiary">{i.key}</span>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{i.title}</span>
                <span className="font-mono text-[11px] text-ink-subtle">{STATE_LABEL[i.state] ?? i.state}</span>
                <span className="w-16 text-right font-mono text-[11px] text-ink-subtle">{PRIORITY_LABEL[i.priority] ?? i.priority}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
