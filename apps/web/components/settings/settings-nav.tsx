"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHref, type SettingsSection } from "@/lib/settings-nav";

// Grouped section list beside every settings page at md and up. The overview
// (/settings) is itself the navigation, so the sidebar steps aside there.
export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const pathname = usePathname();
  if (pathname === "/settings") return null;
  const current = activeHref(pathname);
  return (
    <nav
      aria-label="Settings"
      className="sticky top-0 hidden max-h-dvh w-56 shrink-0 flex-col overflow-y-auto border-r border-lining-faint px-2 pb-6 md:flex"
    >
      <Link
        href="/settings"
        className="mx-0 mt-3 flex h-8 items-center rounded-sm px-2 text-sm font-semibold text-ink hover:bg-surface-2"
      >
        Settings
      </Link>
      {sections.map((s) => (
        <div key={s.id} role="group" aria-labelledby={`settings-nav-${s.id}`}>
          <p
            id={`settings-nav-${s.id}`}
            className="px-2 pb-1 pt-4 text-micro font-medium uppercase tracking-[0.4px] text-ink-subtle"
          >
            {s.label}
          </p>
          <ul>
            {s.items.map((i) => {
              const active = current === i.href;
              return (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex h-8 items-center rounded-sm px-2 text-body ${
                      active ? "bg-surface-3 text-ink" : "text-ink-muted hover:bg-surface-2 hover:text-ink"
                    }`}
                  >
                    {i.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
