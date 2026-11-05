"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { IconCollapse } from "@/components/app/icons";
import { backTarget } from "@/lib/settings-nav";

// Page header for every settings page. At phone width the sidebar is hidden,
// so a back link returns to the parent page or the Settings overview.
export function SettingsHeader({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  const pathname = usePathname();
  const back = pathname === "/settings" ? null : backTarget(pathname);
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-lining-faint px-4 py-2">
      {back && (
        <Link
          href={back.href}
          className="-ml-1 flex h-8 items-center gap-1 rounded-sm pl-0.5 pr-1.5 text-body text-ink-subtle hover:bg-surface-2 hover:text-ink md:hidden"
        >
          <IconCollapse size={14} aria-hidden="true" />
          {back.label}
        </Link>
      )}
      <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
      {(meta || actions) && (
        <div className="ml-auto flex shrink-0 items-center gap-3 font-mono text-micro text-ink-tertiary">
          {meta && <span>{meta}</span>}
          {actions}
        </div>
      )}
    </header>
  );
}
