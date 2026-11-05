import Link from "next/link";
import { IconChevron } from "@/components/app/icons";
import { initials } from "@/lib/format";
import type { SettingsSection } from "@/lib/settings-nav";

const row =
  "flex min-h-12 items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2";

// /settings: the same shape as the iOS Settings sheet. Profile first, then the
// grouped sections, then the destructive actions last.
export function SettingsOverview({
  name,
  email,
  workspaceName,
  isOwner,
  sections,
}: {
  name: string;
  email: string;
  workspaceName: string;
  isOwner: boolean;
  sections: SettingsSection[];
}) {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 p-4 pb-12">
      <Link
        href="/settings/account"
        className="flex items-center gap-4 rounded-md border border-lining bg-surface-1 p-4 hover:bg-surface-2"
      >
        <span
          aria-hidden="true"
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface-3 text-title font-semibold text-ink"
        >
          {initials(name)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-title font-medium text-ink">{name}</span>
          <span className="block truncate text-body text-ink-subtle">
            {email} · {workspaceName}
          </span>
        </span>
        <IconChevron size={14} aria-hidden="true" className="shrink-0 text-ink-subtle" />
      </Link>

      {sections.map((s) => (
        <section key={s.id} aria-labelledby={`settings-group-${s.id}`}>
          <h2
            id={`settings-group-${s.id}`}
            className="px-1 pb-1.5 text-micro font-medium uppercase tracking-[0.4px] text-ink-subtle"
          >
            {s.label}
          </h2>
          <ul className="divide-y divide-lining-faint overflow-hidden rounded-md border border-lining bg-surface-1">
            {s.items.map((i) => {
              return (
                <li key={i.href}>
                  <Link href={i.href} className={row}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body font-medium text-ink">{i.label}</span>
                      <span className="block text-xs text-ink-subtle">
                        {i.description}
                      </span>
                    </span>
                    <IconChevron size={14} aria-hidden="true" className="shrink-0 text-ink-subtle" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <section aria-labelledby="settings-group-danger">
        <h2
          id="settings-group-danger"
          className="px-1 pb-1.5 text-micro font-medium uppercase tracking-[0.4px] text-ink-subtle"
        >
          Danger zone
        </h2>
        <ul className="divide-y divide-lining-faint overflow-hidden rounded-md border border-urgent bg-surface-1">
          {isOwner && (
            <li>
              <Link href="/settings/workspace" className={row}>
                <span className="flex-1 text-body font-medium text-urgent">Delete workspace</span>
                <IconChevron size={14} aria-hidden="true" className="shrink-0 text-ink-subtle" />
              </Link>
            </li>
          )}
          <li>
            <Link href="/settings/account" className={row}>
              <span className="flex-1 text-body font-medium text-urgent">Delete account</span>
              <IconChevron size={14} aria-hidden="true" className="shrink-0 text-ink-subtle" />
            </Link>
          </li>
          <li>
            <form action="/api/logout" method="post">
              <button type="submit" className={`${row} w-full text-body font-medium text-urgent`}>
                Sign out
              </button>
            </form>
          </li>
        </ul>
      </section>
    </div>
  );
}
