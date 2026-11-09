"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { RelativeTime } from "@/components/primitives";
import {
  levelClass,
  openLabel,
  safeLink,
  syncStatusText,
  type ErrorHealth,
} from "@/lib/glitchtip-errors";

const fieldClass =
  "h-8 rounded-sm border border-lining bg-surface-2 px-2 font-mono text-body text-ink outline-none placeholder:text-ink-tertiary focus:border-lining-strong disabled:opacity-50";
const buttonClass =
  "rounded-sm border border-lining px-2.5 py-1 text-xs text-ink hover:bg-surface-2 disabled:opacity-50";
const ghostClass =
  "rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-50";

// A project's production error health, read from Tallyline's cache of its
// mapped GlitchTip project. Admins map and unmap; members can sync and file a
// ticket from an error. Every failure stays visible and nothing is changed
// silently.
export function ProjectErrors({
  projectId,
  health,
  canAdmin,
}: {
  projectId: string;
  health: ErrorHealth | null;
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [orgSlug, setOrgSlug] = useState("");
  const [projectSlug, setProjectSlug] = useState("");
  const [tickets, setTickets] = useState<Record<string, string>>({});

  async function call(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/glitchtip${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = (await res.json().catch(() => null)) as
        | (Record<string, unknown> & { error?: { message?: string } })
        | null;
      if (!res.ok) {
        setMessage(data?.error?.message ?? "That did not work. Nothing was changed.");
        return null;
      }
      return data ?? {};
    } catch {
      setMessage("Could not reach the server. Nothing was changed.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function mapProject() {
    if (!orgSlug.trim() || !projectSlug.trim()) {
      setMessage("Enter the GlitchTip organization and project slugs.");
      return;
    }
    if (await call("PUT", "", { orgSlug: orgSlug.trim(), projectSlug: projectSlug.trim() })) router.refresh();
  }

  async function unmap() {
    if (!confirm("Stop showing GlitchTip errors on this project?")) return;
    if (await call("DELETE", "")) router.refresh();
  }

  async function syncNow() {
    const data = await call("POST", "/sync");
    if (!data) return;
    if (data.sync === "skipped") setMessage("GlitchTip asked us to wait; the next sync runs when it allows.");
    router.refresh();
  }

  async function fileTicket(issueId: string) {
    const data = await call("POST", `/issues/${encodeURIComponent(issueId)}/ticket`);
    const ticket = data?.ticket as { key?: string } | undefined;
    if (ticket?.key) setTickets((t) => ({ ...t, [issueId]: ticket.key! }));
  }

  return (
    <section aria-labelledby="errors-heading" className="flex flex-col gap-3">
      <h2 id="errors-heading" className="text-micro uppercase text-ink-tertiary">
        Production errors
      </h2>
      {message && (
        <p role="alert" className="rounded-sm border border-lining-bright px-3 py-2 text-body text-ink-muted">
          {message}
        </p>
      )}
      {health === null ? (
        <p className="text-body text-ink-subtle">The error feed did not load. Nothing was changed.</p>
      ) : !health.connected ? (
        <p className="text-body text-ink-subtle">
          GlitchTip is not connected to this workspace.{" "}
          {canAdmin ? (
            <Link href="/settings/integrations" className="text-accent hover:underline">
              Connect it in Settings
            </Link>
          ) : (
            "Ask an admin to connect it."
          )}
        </p>
      ) : !health.mapped ? (
        canAdmin ? (
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-ink-subtle">
              GlitchTip organization
              <input
                value={orgSlug}
                onChange={(e) => setOrgSlug(e.target.value)}
                placeholder="acme"
                className={fieldClass}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-ink-subtle">
              GlitchTip project
              <input
                value={projectSlug}
                onChange={(e) => setProjectSlug(e.target.value)}
                placeholder="api"
                className={fieldClass}
              />
            </label>
            <button onClick={mapProject} disabled={busy} className={buttonClass}>
              Show errors here
            </button>
          </div>
        ) : (
          <p className="text-body text-ink-subtle">This project has no GlitchTip mapping yet.</p>
        )
      ) : (
        <div className="rounded-md border border-lining-faint bg-surface-2 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-ink">{openLabel(health.openCount, health.openCapped)}</span>
            <span className="text-ink-muted">{syncStatusText(health.status)}</span>
            {health.lastSyncedAt && (
              <span className="text-ink-tertiary">
                synced <RelativeTime iso={health.lastSyncedAt} />
                {health.stale ? " (stale)" : ""}
              </span>
            )}
            <span className="ml-auto flex items-center gap-1">
              {health.link && safeLink(health.link.url) && (
                <a
                  href={safeLink(health.link.url)!}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-sm px-2 py-1 text-ink-subtle hover:bg-surface-2 hover:text-ink"
                >
                  Open GlitchTip ↗
                </a>
              )}
              <button onClick={syncNow} disabled={busy} className={ghostClass}>
                Sync now
              </button>
              {canAdmin && (
                <button onClick={unmap} disabled={busy} className={ghostClass}>
                  Unmap
                </button>
              )}
            </span>
          </div>
          {health.recent.length === 0 ? (
            <p className="text-body text-ink-subtle">
              {health.status === "ok" ? "No open errors. Nothing has failed in production lately." : "No errors to show yet."}
            </p>
          ) : (
            <ol className="flex flex-col divide-y divide-lining-faint">
              {health.recent.map((e) => {
                const href = safeLink(e.link);
                const key = tickets[e.glitchtipId];
                return (
                  <li key={e.id} data-error-id={e.glitchtipId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-body">
                    <span className={`font-mono text-micro uppercase ${levelClass(e.level)}`}>{e.level}</span>
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-ink hover:underline">
                        {e.title}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-ink">{e.title}</span>
                    )}
                    <span className="font-mono text-micro text-ink-tertiary">
                      {e.count} events · {e.userCount} people
                    </span>
                    {e.lastSeen && <RelativeTime iso={e.lastSeen} />}
                    {key ? (
                      <Link href={`/issues/${key}`} className="font-mono text-micro text-accent hover:underline">
                        {key}
                      </Link>
                    ) : e.ticketIssueId ? (
                      <span className="font-mono text-micro text-ink-tertiary">ticket filed</span>
                    ) : (
                      <button onClick={() => fileTicket(e.glitchtipId)} disabled={busy} className={ghostClass}>
                        File ticket
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
