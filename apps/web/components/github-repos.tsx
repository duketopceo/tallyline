"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export interface GithubRepoRow {
  id: string;
  fullName: string;
  installationId: number | null;
  enabled: boolean;
  projectId?: string | null;
}

export interface ProjectOption {
  id: string;
  name: string;
}

export function GithubRepoPanel({
  repos,
  installed,
  installUrl,
  projects = [],
}: {
  repos: GithubRepoRow[];
  installed: boolean;
  installUrl: string | null;
  projects?: ProjectOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? repos.filter((r) => r.fullName.toLowerCase().includes(q))
      : repos;
    return [...filtered].sort(
      (a, b) => Number(b.enabled) - Number(a.enabled) || a.fullName.localeCompare(b.fullName),
    );
  }, [repos, query]);

  const enabledCount = repos.filter((r) => r.enabled).length;

  async function setEnabled(repo: GithubRepoRow, next: boolean) {
    setBusy(repo.id);
    setError(null);
    const res = await fetch("/api/settings/github/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: repo.fullName,
        action: next ? "connect" : "disconnect",
      }),
    });
    setBusy(null);
    if (res.ok) {
      router.refresh();
    } else {
      const d = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(d?.error?.message ?? `could not ${next ? "connect" : "disconnect"} ${repo.fullName}`);
    }
  }

  async function setProject(repo: GithubRepoRow, projectId: string) {
    setBusy(repo.id);
    setError(null);
    const res = await fetch("/api/settings/github/repos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: repo.fullName,
        action: "project",
        projectId: projectId || null,
      }),
    });
    setBusy(null);
    if (res.ok) {
      router.refresh();
    } else {
      setError(`could not set the project for ${repo.fullName}`);
    }
  }

  if (!installed && repos.length === 0) {
    return (
      <div className="p-4 text-sm text-ink-subtle">
        <p>GitHub is not connected.</p>
        {installUrl && (
          <p className="mt-2">
            <a href={installUrl} className="text-accent hover:text-accent-hover">
              Install the GitHub App ↗
            </a>{" "}
            to link repositories for two-way issue sync.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="p-4">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted"
        >
          {error}
        </p>
      )}
      <div className="mb-3 flex items-center gap-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter repositories…"
          aria-label="Filter repositories"
          className="h-8 w-64 rounded-sm border border-lining bg-surface-2 px-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-lining-strong"
        />
        <span className="font-mono text-[11px] text-ink-tertiary">
          {enabledCount} connected · {repos.length} available
        </span>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-lining-faint text-left font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
            <th className="pb-2 font-normal">Repository</th>
            <th className="pb-2 font-normal">Sync</th>
            <th className="pb-2 font-normal">Project</th>
            <th className="pb-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-lining-faint">
              <td className="py-2.5 pr-4 font-mono text-[13px] text-ink">
                {r.fullName}
              </td>
              <td className="py-2.5 pr-4">
                <span
                  className={`font-mono text-[11px] uppercase tracking-wider ${
                    r.enabled ? "text-accent" : "text-ink-tertiary"
                  }`}
                >
                  {r.enabled ? "on" : "off"}
                </span>
              </td>
              <td className="py-2.5 pr-4">
                <select
                  aria-label={`Project for ${r.fullName}`}
                  value={r.projectId ?? ""}
                  disabled={busy === r.id}
                  onChange={(e) => setProject(r, e.target.value)}
                  className="h-7 rounded-sm border border-lining bg-surface-2 px-1.5 text-[13px] text-ink outline-none focus:border-lining-strong disabled:opacity-50"
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2.5 text-right">
                <button
                  onClick={() => setEnabled(r, !r.enabled)}
                  disabled={busy === r.id}
                  className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                >
                  {r.enabled ? "disconnect" : "connect"}
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-6 text-center text-ink-tertiary">
                no repositories match
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
