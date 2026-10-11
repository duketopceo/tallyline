"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useActions } from "@/components/app/actions";
import { useMeta } from "@/components/app/providers";
import { Kbd, StateGlyph } from "@/components/app/ui";
import type { ListIssue } from "@/components/issue-list-client";
import { colonHint, runColonCommand } from "@/lib/colon-commands";

interface CommandPaletteProps {
  workspace: string;
}

function isTypingTarget(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
}

const RECENT_KEY = "tl:recent";
export function recordRecent(key: string) {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...cur.filter((k) => k !== key)].slice(0, 6)));
  } catch { /* ignore */ }
}

const ROW = "flex h-10 cursor-pointer items-center gap-3 rounded-sm px-2 text-[13px] text-ink-muted aria-selected:bg-surface-3 aria-selected:text-ink";
const GROUP = "px-1 py-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.4px] [&_[cmdk-group-heading]]:text-ink-subtle";

export function CommandPalette({ workspace }: CommandPaletteProps) {
  const router = useRouter();
  const meta = useMeta();
  const actions = useActions();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ListIssue[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);

  const colonMode = query.startsWith(":");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === ":" && !isTypingTarget(e.target)) {
        e.preventDefault();
        setOpen(true);
        setQuery(":");
        setStatus(null);
      }
    }
    document.addEventListener("keydown", onKey);
    // e2e hydration signal tied to THIS listener (not a sibling's): a `:` or
    // ctrl+k pressed before it exists is silently lost
    document.documentElement.dataset.paletteReady = "1";
    return () => {
      document.removeEventListener("keydown", onKey);
      delete document.documentElement.dataset.paletteReady;
    };
  }, []);

  useEffect(() => {
    if (open) {
      try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[]); } catch { setRecent([]); }
    } else setQuery("");
  }, [open]);

  useEffect(() => {
    if (!open || query.length < 2 || colonMode) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const res = await fetch(`/api/issues/search?q=${encodeURIComponent(query)}`);
      if (res.ok) setResults(((await res.json()) as { issues?: ListIssue[] }).issues ?? []);
    }, 150);
    return () => clearTimeout(t);
  }, [open, query, colonMode]);

  const go = useCallback((path: string) => {
    setOpen(false);
    router.push(path);
  }, [router]);

  const grouped = useMemo(() => {
    const m = new Map<string, typeof actions>();
    for (const a of actions) m.set(a.group, [...(m.get(a.group) ?? []), a]);
    const order = ["Issue", "Triage", "Create", "View", "Navigate", "Edit", "Help", "Account"];
    return [...m.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 99) - (order.indexOf(b[0]) + 1 || 99));
  }, [actions]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;
  void meta;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center bg-overlay pt-[12vh] max-sm:pt-[6vh]"
      onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}
    >
      <Command
        data-palette
        className="w-full max-w-[640px] overflow-hidden rounded-md border border-lining-bright bg-surface-1 max-sm:mx-2"
        label="Command palette"
        aria-label="Command palette"
        role="dialog"
        aria-modal="true"
      >
        <Command.Input
          autoFocus
          value={query}
          onValueChange={(v) => { setQuery(v); setStatus(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && colonMode) {
              e.preventDefault();
              const line = query.slice(1);
              if (!line.trim()) return;
              void runColonCommand(line).then((r) => {
                if (r.navigate) go(r.navigate);
                else { setStatus(r.message); if (r.ok) router.refresh(); }
              });
            }
          }}
          placeholder="Search issues or run a command"
          aria-label="Search issues or run a command"
          className="h-12 w-full border-b border-lining-faint bg-transparent px-4 text-[14px] text-ink placeholder:text-ink-subtle focus:outline-none"
        />
        <Command.List className="scroll-quiet max-h-[min(420px,60vh)] overflow-y-auto p-1">
          {colonMode ? (
            <div className="px-3 py-4">
              <p className="font-mono text-[12px] text-ink-muted">{colonHint(query.slice(1))}</p>
              <p className="mt-1 text-[11px] text-ink-subtle"><Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close{status && <span className="ml-2 text-accent">{status}</span>}</p>
            </div>
          ) : (
            <>
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-subtle">Nothing matches. Try an issue key or a verb like “assign”.</Command.Empty>
              {results.length > 0 && (
                <Command.Group heading="Issues" className={GROUP}>
                  {results.map((issue) => (
                    <Command.Item key={issue.key} value={`${issue.key} ${issue.title}`} onSelect={() => { recordRecent(issue.key); go(`/issues/${issue.key}`); }} className={ROW}>
                      <StateGlyph state={issue.state} labelled={false} />
                      <span className="w-[68px] shrink-0 font-mono text-[12px] text-ink-subtle">{issue.key}</span>
                      <span className="truncate">{issue.title}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {!query && recent.length > 0 && (
                <Command.Group heading="Recent" className={GROUP}>
                  {recent.map((k) => (
                    <Command.Item key={k} value={`recent ${k}`} onSelect={() => go(`/issues/${k}`)} className={ROW}>
                      <span className="font-mono text-[12px] text-ink-subtle">{k}</span><span className="text-ink-subtle">Recently opened</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {grouped.map(([group, list]) => (
                <Command.Group key={group} heading={group} className={GROUP}>
                  {list.map((a) => (
                    <Command.Item key={a.id} value={`${a.group} ${a.label}`} data-action={a.id} onSelect={() => { setOpen(false); setTimeout(a.run, 0); }} className={ROW}>
                      {a.label}
                      {a.keys && <span className="ml-auto flex gap-1">{a.keys.split(" ").map((k, i) => <Kbd key={i}>{k}</Kbd>)}</span>}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </>
          )}
        </Command.List>
        <div className="flex h-8 items-center justify-between border-t border-lining-faint px-3 text-[11px] text-ink-subtle">
          <span>{workspace} · <Kbd>:</Kbd> command mode</span>
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate · <Kbd>Enter</Kbd> run · <Kbd>Esc</Kbd> close</span>
        </div>
      </Command>
    </div>
  );
}
