import type { ReactNode } from "react";

export function PageHeader({ title, count, hint, children }: { title: string; count?: number | undefined; hint?: string | undefined; children?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-lining-faint px-4 py-1.5">
      <h1 className="text-[15px] font-semibold">{title}</h1>
      {count !== undefined && <span className="text-[12px] tabular-nums text-ink-subtle">{count}{hint ? ` ${hint}` : ""}</span>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
}
