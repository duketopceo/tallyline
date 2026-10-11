"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Membership {
  workspaceId: string;
  workspaceSlug: string;
  role: string;
}

export function WorkspaceChooser({
  memberships,
}: {
  memberships: Membership[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pick(slug: string) {
    setPending(slug);
    setError(null);
    const res = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceSlug: slug }),
    });
    if (res.ok) {
      router.replace("/my-issues");
      router.refresh();
    } else {
      setPending(null);
      const d = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(d?.error?.message ?? "could not enter that workspace");
    }
  }

  return (
    <div className="mt-5 space-y-2">
      {error && (
        <p
          role="alert"
          className="rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted"
        >
          {error}
        </p>
      )}
      {memberships.map((m) => (
        <button
          key={m.workspaceId}
          onClick={() => pick(m.workspaceSlug)}
          disabled={pending !== null}
          className="flex w-full items-center justify-between rounded-sm border border-lining bg-surface-2 px-4 py-3 text-left hover:border-lining-strong disabled:opacity-60"
        >
          <span className="text-sm font-medium text-ink">
            {m.workspaceSlug}
          </span>
          <span className="font-mono text-[11px] uppercase tracking-widest text-ink-subtle">
            {pending === m.workspaceSlug ? "entering…" : m.role}
          </span>
        </button>
      ))}
    </div>
  );
}
