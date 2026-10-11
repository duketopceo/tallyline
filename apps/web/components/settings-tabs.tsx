"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/settings/members", label: "Members" },
  { href: "/settings/invites", label: "Invites" },
  { href: "/settings/agents", label: "Agents" },
  { href: "/settings/tokens", label: "Tokens" },
  { href: "/settings/labels", label: "Labels" },
  { href: "/settings/projects", label: "Projects" },
  { href: "/settings/cycles", label: "Cycles" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/providers", label: "Providers" },
  { href: "/settings/workspace", label: "Workspace" },
  { href: "/settings/account", label: "Account" },
];

export function SettingsTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`flex h-7 shrink-0 items-center rounded-sm px-2 text-[12px] ${
              active
                ? "bg-surface-2 text-ink"
                : "text-ink-subtle hover:bg-surface-2 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
