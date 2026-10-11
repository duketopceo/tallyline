import Link from "next/link";
import type { ReactNode } from "react";
import { LegalLinks } from "@/components/legal-links";
import { TallyMark } from "@/components/tally-mark";

// Public trust pages (PLAN-016): privacy, terms, security, status.
// Static text, no tracking scripts, no third-party requests.
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <header className="border-b border-lining-faint">
        <div className="mx-auto flex h-14 max-w-3xl items-center gap-4 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <TallyMark size={20} />
            <span className="text-sm font-semibold tracking-tight">tallyline</span>
          </Link>
          <Link
            href="/login"
            className="ml-auto rounded-sm border border-lining bg-surface-1 px-3 py-1.5 text-sm text-ink-muted hover:border-lining-strong hover:text-ink"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main id="content" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6">
        {children}
      </main>
      <footer className="border-t border-lining-faint">
        <div className="mx-auto max-w-3xl px-4 py-6 text-[12px] text-ink-tertiary sm:px-6">
          <LegalLinks />
        </div>
      </footer>
    </div>
  );
}
