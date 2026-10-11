"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { formatDate } from "@/components/account/ui";

// App-wide account states:
// - unverified email: a slim strip above every screen (they can work, but
//   cannot mint tokens or agent keys until they confirm)
// - active workspace pending deletion: every screen except Settings is
//   replaced by the restore path, because the API answers 410 everywhere else
export function AccountGate({
  emailVerified,
  pendingDeletion,
  children,
}: {
  emailVerified: boolean;
  pendingDeletion: { name: string; purgeAfter: string } | null;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const inSettings = pathname.startsWith("/settings");
  return (
    <>
      {!emailVerified && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-lining-bright bg-attention-soft px-4 py-2 text-[13px] text-ink"
        >
          <span aria-hidden="true" className="font-mono text-attention">
            !
          </span>
          <span>Confirm your email to create personal access tokens and agent keys.</span>
          <Link href="/settings/account" className="text-accent hover:underline">
            Send a new link
          </Link>
        </div>
      )}
      {pendingDeletion && !inSettings ? (
        <main className="flex flex-1 items-center justify-center p-4">
          <div role="status" className="w-full max-w-md rounded-md border border-lining-bright bg-surface-1 p-5">
            <p className="flex items-center gap-2 text-sm font-medium text-attention">
              <span aria-hidden="true" className="font-mono">
                !
              </span>
              {pendingDeletion.name} is scheduled for deletion
            </p>
            <p className="mt-2 text-[13px] text-ink-muted">
              It is closed for everyone and will be permanently deleted on{" "}
              <time dateTime={pendingDeletion.purgeAfter}>{formatDate(pendingDeletion.purgeAfter)}</time>. An owner
              can restore it until then.
            </p>
            <Link
              href="/settings/workspace"
              className="mt-4 inline-flex min-h-8 items-center rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent hover:bg-accent-hover"
            >
              Open workspace settings
            </Link>
          </div>
        </main>
      ) : (
        children
      )}
    </>
  );
}
