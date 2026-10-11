import Link from "next/link";

// Public trust pages (PLAN-016). Shared by the landing footer, the sign-in
// card and the legal pages themselves, so the set never drifts.
export const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/security", label: "Security" },
  { href: "/status", label: "Status" },
] as const;

export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Legal and trust" className={className}>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {LEGAL_LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="underline-offset-2 hover:text-ink-muted hover:underline">
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
