import Link from "next/link";
import type { Metadata } from "next";
import { LegalDoc, Section } from "@/components/legal-doc";
import { API_URL } from "@/lib/api";

export const metadata: Metadata = {
  title: "Status · Tallyline",
  description: "Live health of the Tallyline API and its database and queue.",
};

type Health = "ok" | "degraded" | "unreachable";

// Live, server-side read of the API's own /health (no third-party status
// service, nothing runs in the browser).
async function readHealth(): Promise<{ status: Health; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    const body = (await res.json().catch(() => null)) as { status?: string } | null;
    // only the API's own answer counts; a proxy error page means unreachable
    if (body?.status === "ok") return { status: "ok", checkedAt };
    if (body?.status === "degraded") return { status: "degraded", checkedAt };
    return { status: "unreachable", checkedAt };
  } catch {
    return { status: "unreachable", checkedAt };
  }
}

const COPY: Record<Health, { label: string; detail: string }> = {
  ok: { label: "All systems working", detail: "The API, database and queue answered the health check." },
  degraded: {
    label: "Degraded",
    detail: "The API is up but its database or queue did not answer. Some actions may fail; retry in a few minutes.",
  },
  unreachable: {
    label: "API unreachable",
    detail: "This page could not reach the API. Retry in a few minutes; if it persists, tell the admin who runs this instance.",
  },
};

export default async function StatusPage() {
  const h = await readHealth();
  const copy = COPY[h.status];
  return (
    <LegalDoc
      title="Status"
      updated={new Date(h.checkedAt).toUTCString()}
      updatedLabel="Checked"
      draft={false}
      summary={<p>Live health of this Tallyline instance, checked when the page loads.</p>}
    >
      <div role="status" className="mt-6 flex items-start gap-3 rounded-sm border border-lining bg-surface-1 p-4">
        <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" className="mt-1 shrink-0">
          {h.status === "ok" ? (
            <circle cx="7" cy="7" r="6" fill="var(--sl-status-healthy)" />
          ) : h.status === "degraded" ? (
            <path d="M7 1 13 13H1Z" fill="var(--sl-status-attention)" />
          ) : (
            <rect x="1" y="1" width="12" height="12" rx="2" fill="var(--sl-status-urgent)" />
          )}
        </svg>
        <div>
          <p className="text-[15px] font-semibold text-ink">{copy.label}</p>
          <p className="mt-1 text-[13px] text-ink-muted">{copy.detail}</p>
        </div>
      </div>

      <Section id="incidents" title="Incidents and maintenance">
        <p>
          Tallyline Cloud is in beta and has no uptime guarantee yet. Planned maintenance and
          incident write-ups will be posted here. Security issues: see the{" "}
          <Link href="/security">security page</Link>.
        </p>
      </Section>
    </LegalDoc>
  );
}
