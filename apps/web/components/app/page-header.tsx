import type { ReactNode } from "react";
import { ProjectIcon } from "@/components/project-icon";

export function PageHeader({ title, count, hint, logo, children }: { title: string; count?: number | undefined; hint?: string | undefined; logo?: { name: string; iconUrl?: string | null } | undefined; children?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-lining-faint px-4 py-1.5">
      {logo && <ProjectIcon name={logo.name} iconUrl={logo.iconUrl} size={20} />}
      <h1 className="text-title font-semibold">{title}</h1>
      {count !== undefined && <span className="text-xs tabular-nums text-ink-subtle">{count}{hint ? ` ${hint}` : ""}</span>}
      {children && <div className="ml-auto flex items-center gap-2">{children}</div>}
    </header>
  );
}
