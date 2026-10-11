"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { filtersFromObject, filtersToQuery } from "@/lib/filters";
import { TallyMark } from "../tally-mark";
import { useRegisterActions } from "./actions";
import { NavIcon } from "./nav-icons";
import { useMeta } from "./providers";
import { Kbd } from "./ui";

interface Item { href: string; label: string; hint: string; icon: string; count?: number }

const MIN_W = 200, MAX_W = 320, RAIL_W = 56;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // storage unavailable (private mode): the shell still works, just unremembered
  }
}

export function Shell({ children, peek }: { children: ReactNode; peek: ReactNode }) {
  const meta = useMeta();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [collapsed, setCollapsed] = useState(false);
  const [width, setWidth] = useState(232);
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);

  // remembered per device, applied after mount so SSR and hydration agree
  useEffect(() => {
    setCollapsed(read("tl:sidebar:collapsed", false));
    setWidth(Math.min(MAX_W, Math.max(MIN_W, read("tl:sidebar:width", 232))));
  }, []);
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    drawerRef.current?.querySelector<HTMLElement>("a")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawer]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      write("tl:sidebar:collapsed", !c);
      return !c;
    });
  }, []);

  useRegisterActions(
    "shell",
    [
      { id: "sidebar", label: "Toggle sidebar", group: "View", keys: "[" },
      { id: "palette-help", label: "Show keyboard shortcuts", group: "Help", keys: "?" },
      ...(meta.role === "owner" || meta.role === "admin" ? [{ id: "settings", label: "Go to Settings", group: "Navigate", keys: "g ," }] : []),
    ],
    (id) => {
      if (id === "sidebar") toggleCollapsed();
      else if (id === "palette-help") document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
      else if (id === "settings") router.push("/settings/members");
    },
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      if (e.key !== "[" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      toggleCollapsed();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [toggleCollapsed]);

  const work: Item[] = [
    { href: "/triage", label: "Triage", hint: "g t", icon: "triage", count: meta.counts.triage },
    { href: "/review", label: "Review", hint: "g r", icon: "review", count: meta.counts.review },
    { href: "/board", label: "Board", hint: "g b", icon: "board" },
    { href: "/issues", label: "Issues", hint: "g a", icon: "issues" },
    { href: "/cycle", label: "Cycles", hint: "g c", icon: "cycle" },
    { href: "/roadmap", label: "Roadmap", hint: "g p", icon: "roadmap" },
  ];
  const more: Item[] = [
    { href: "/activity", label: "Activity", hint: "g e", icon: "activity" },
    { href: "/insights", label: "Insights", hint: "g s", icon: "insights" },
    ...(meta.role === "owner" || meta.role === "admin" ? [{ href: "/settings/members", label: "Settings", hint: "g ,", icon: "settings" }] : []),
  ];
  const mine: Item = { href: "/my-issues", label: "My issues", hint: "g i", icon: "my-issues" };

  const curQuery = search.toString();
  const views = meta.views.map((v) => ({ ...v, q: filtersToQuery(filtersFromObject(v.filters)) }));
  const activeView = pathname === "/issues" ? views.find((v) => v.q === curQuery) : undefined;
  const isActive = (it: Item) =>
    it.href === "/issues" ? (pathname === "/issues" && !activeView) || pathname.startsWith("/issues/") : pathname.startsWith(it.href.split("/").slice(0, 2).join("/"));

  const rail = collapsed;
  const link = (it: Item) => (
    <li key={it.href}>
      <Link
        href={it.href}
        title={rail ? `${it.label} (${it.hint})` : undefined}
        aria-current={isActive(it) ? "page" : undefined}
        className={`group flex h-8 items-center gap-2.5 rounded-sm px-2 text-[13px] ${isActive(it) ? "bg-surface-3 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"} ${rail ? "justify-center" : ""}`}
      >
        <NavIcon name={it.icon} />
        {!rail && (
          <>
            <span className="truncate">{it.label}</span>
            {it.count ? (
              <span className="ml-auto rounded-full bg-surface-3 px-1.5 text-[11px] tabular-nums text-ink-muted" aria-label={`${it.count} waiting`}>{it.count > 99 ? "99+" : it.count}</span>
            ) : (
              <kbd className="ml-auto hidden font-mono text-[11px] text-ink-subtle group-hover:inline">{it.hint}</kbd>
            )}
          </>
        )}
        {rail && it.count ? <span className="sr-only">{it.count} waiting</span> : null}
      </Link>
    </li>
  );

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const move = (ev: PointerEvent) => setWidth(Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX)));
    const up = (ev: PointerEvent) => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      write("tl:sidebar:width", Math.min(MAX_W, Math.max(MIN_W, startW + ev.clientX - startX)));
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  };

  const sidebar = (
    <aside
      ref={drawerRef}
      aria-label="Sidebar"
      style={{ width: rail ? RAIL_W : width }}
      className={`relative flex shrink-0 flex-col border-r border-lining bg-surface-1 ${drawer ? "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-50 max-lg:!w-[272px]" : "max-lg:hidden"}`}
    >
      <div className={`flex h-12 shrink-0 items-center gap-2 border-b border-lining-faint ${rail ? "justify-center" : "px-3"}`}>
        <TallyMark size={16} />
        {!rail && (
          <>
            <span className="text-[14px] font-semibold tracking-tight">tallyline</span>
            <span className="ml-auto truncate rounded-xs border border-lining px-1.5 font-mono text-[11px] text-ink-subtle" title={`Workspace ${meta.workspace}`}>{meta.workspace}</span>
          </>
        )}
      </div>
      <div className={`flex gap-1 p-2 ${rail ? "flex-col" : ""}`}>
        <button
          type="button"
          onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}
          aria-label="Search and commands"
          className={`flex h-8 flex-1 items-center gap-2 rounded-sm border border-control px-2 text-[13px] text-ink-subtle hover:bg-surface-2 hover:text-ink ${rail ? "justify-center" : ""}`}
        >
          <NavIcon name="search" />
          {!rail && (<><span>Search</span><span className="ml-auto"><Kbd>⌘K</Kbd></span></>)}
        </button>
        <button
          type="button"
          onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }))}
          aria-label="New issue"
          title="New issue (c)"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm bg-accent text-on-accent hover:bg-accent-hover max-lg:w-9"
        >
          <NavIcon name="plus" />
        </button>
      </div>
      <nav aria-label="Primary" className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <ul>{link(mine)}</ul>
        {!rail && <p className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Work</p>}
        {rail && <hr className="my-2 border-lining-faint" />}
        <ul>{work.map(link)}</ul>
        {views.length > 0 && !rail && (
          <>
            <p className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Views</p>
            <ul>
              {views.map((v) => (
                <li key={v.id}>
                  <Link
                    href={`/issues?${v.q}`}
                    aria-current={activeView?.id === v.id ? "page" : undefined}
                    className={`flex h-8 items-center gap-2.5 rounded-sm px-2 text-[13px] ${activeView?.id === v.id ? "bg-surface-3 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"}`}
                  >
                    <NavIcon name="view" />
                    <span className="truncate">{v.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
        {rail ? <hr className="my-2 border-lining-faint" /> : <p className="px-2 pb-1 pt-4 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Workspace</p>}
        <ul>{more.map(link)}</ul>
      </nav>
      <div className={`flex shrink-0 gap-1 border-t border-lining-faint p-2 ${rail ? "flex-col items-center" : "flex-col"}`}>
        {!rail && <p className="truncate px-2 text-[12px] text-ink-muted" title={meta.userName}>{meta.userName}</p>}
        <div className={`flex items-center gap-1 ${rail ? "flex-col" : ""}`}>
        <Link href="/settings/appearance" title="Appearance" className="flex h-8 items-center rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">{rail ? "Aa" : "Appearance"}</Link>
        <form action="/api/logout" method="post" className={rail ? "" : "ml-auto"}>
          <button type="submit" className="h-8 whitespace-nowrap rounded-sm px-2 text-[12px] text-ink-subtle hover:bg-surface-2 hover:text-ink">{rail ? "Out" : "Sign out"}</button>
        </form>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={rail ? "Expand sidebar" : "Collapse sidebar"}
          title="Toggle sidebar ["
          className="hidden h-8 w-8 items-center justify-center rounded-sm text-ink-subtle hover:bg-surface-2 hover:text-ink lg:flex"
        >
          <span className={rail ? "rotate-180" : ""}><NavIcon name="collapse" /></span>
        </button>
        </div>
      </div>
      {!rail && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          aria-valuemin={MIN_W}
          aria-valuemax={MAX_W}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const w = Math.min(MAX_W, Math.max(MIN_W, width + (e.key === "ArrowRight" ? 16 : -16)));
            setWidth(w);
            write("tl:sidebar:width", w);
          }}
          className="absolute -right-1 top-0 hidden h-full w-2 cursor-col-resize hover:bg-accent/30 focus-visible:bg-accent/40 lg:block"
        />
      )}
    </aside>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {drawer && <div className="fixed inset-0 z-40 bg-canvas/70 lg:hidden" onClick={() => setDrawer(false)} aria-hidden />}
      {sidebar}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-lining-faint px-2 lg:hidden">
          <button type="button" onClick={() => setDrawer(true)} aria-label="Open menu" className="flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-2"><NavIcon name="menu" size={18} /></button>
          <TallyMark size={16} />
          <span className="text-[14px] font-semibold tracking-tight">tallyline</span>
          <button type="button" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))} aria-label="Search and commands" className="ml-auto flex h-9 w-9 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-2"><NavIcon name="search" size={18} /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col max-sm:pb-14">{children}</div>
      </div>
      {peek}
      <nav aria-label="Quick actions" className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch justify-around border-t border-lining bg-surface-1 sm:hidden">
        {[["/my-issues", "My issues", "my-issues"], ["/board", "Board", "board"], ["/review", "Review", "review"]].map(([href, label, icon]) => (
          <Link key={href} href={href!} className={`flex min-w-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${pathname.startsWith(href!) ? "text-ink" : "text-ink-subtle"}`}>
            <NavIcon name={icon!} size={18} />{label}
          </Link>
        ))}
        <button type="button" onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }))} className="flex min-w-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-accent">
          <NavIcon name="plus" size={18} />New
        </button>
      </nav>
    </div>
  );
}
