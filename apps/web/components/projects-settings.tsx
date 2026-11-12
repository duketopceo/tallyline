"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ProjectIcon } from "@/components/project-icon";
import { isPublicLogoUrl, normalizeLogoInput } from "@/lib/project-logo";

export interface ProjectRow {
  id: string;
  name: string;
  status: string;
  description: string | null;
  iconUrl?: string | null;
  startDate: string | null;
  targetDate: string | null;
}

const STATUSES = [
  "backlog",
  "planned",
  "started",
  "paused",
  "completed",
  "canceled",
] as const;

async function err(res: Response, fallback: string) {
  const d = (await res.json().catch(() => null)) as {
    error?: { message?: unknown };
  } | null;
  const message = d?.error?.message;
  // validation failures come back as an issue array; never show raw JSON
  if (typeof message === "string" && message) return message;
  if (res.status === 400) return "That value was not accepted. Use a public https URL for the logo.";
  return fallback;
}

export function ProjectsSettings({ projects }: { projects: ProjectRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // a row's logo field is open only while it is being edited
  const [logoEdit, setLogoEdit] = useState<string | null>(null);
  const [logoDraft, setLogoDraft] = useState<Record<string, string>>({});

  async function run(
    path: string,
    init: RequestInit,
    fallback: string,
    busyKey = "form",
  ) {
    setBusy(busyKey);
    setError(null);
    const res = await fetch(path, init);
    setBusy(null);
    if (res.ok) {
      router.refresh();
      return true;
    }
    setError(await err(res, fallback));
    return false;
  }

  async function create() {
    const ok = await run(
      "/api/projects",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        }),
      },
      "could not create project",
    );
    if (ok) {
      setName("");
      setDescription("");
    }
  }

  async function setStatus(p: ProjectRow, status: string) {
    await run(
      `/api/projects/${p.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      },
      "could not update project",
      p.id,
    );
  }

  async function saveLogo(p: ProjectRow) {
    const draft = (logoDraft[p.id] ?? "").trim();
    let iconUrl: string | null = null;
    if (draft) {
      iconUrl = normalizeLogoInput(draft);
      if (!iconUrl || !isPublicLogoUrl(iconUrl)) {
        setError("Use an https URL for the logo, e.g. https://example.com/logo.svg");
        return;
      }
    }
    const ok = await run(
      `/api/projects/${p.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ iconUrl }),
      },
      "could not update the logo",
      p.id,
    );
    if (ok) {
      setLogoEdit(null);
      setLogoDraft((d) => {
        const next = { ...d };
        delete next[p.id];
        return next;
      });
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-4">
      {error && (
        <p
          role="alert"
          className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted"
        >
          {error}
        </p>
      )}

      <form
        className="mb-4 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New project name"
            required
            maxLength={200}
            className="min-w-0 flex-1 rounded-sm border border-control bg-surface-1 px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-disabled focus-visible:outline-2 focus-visible:outline-accent"
          />
          <button
            type="submit"
            disabled={busy === "form" || !name.trim()}
            className="rounded-sm bg-accent px-3 py-1.5 text-[13px] font-medium text-on-accent disabled:opacity-50"
          >
            Add project
          </button>
        </div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="rounded-sm border border-control bg-surface-1 px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-disabled focus-visible:outline-2 focus-visible:outline-accent"
        />
      </form>

      {projects.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-subtle">
          No projects yet. Projects group issues across cycles — set one from
          an issue's property rail.
        </p>
      ) : (
        <>
          <p className="mb-2 text-[12px] text-ink-subtle">
            Click a project&apos;s logo to add or change it.
          </p>
        <ul className="divide-y divide-lining-faint rounded-sm border border-lining">
          {projects.map((p) => (
            <li key={p.id} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setLogoEdit((cur) => (cur === p.id ? null : p.id));
                    setLogoDraft((d) =>
                      p.id in d ? d : { ...d, [p.id]: p.iconUrl ?? "" },
                    );
                  }}
                  aria-expanded={logoEdit === p.id}
                  aria-label={`Logo for ${p.name}`}
                  title={p.iconUrl ? "Change logo" : "Add a logo"}
                  className="shrink-0 rounded-xs hover:ring-1 hover:ring-lining-bright focus-visible:outline-2 focus-visible:outline-accent"
                >
                  <ProjectIcon name={p.name} iconUrl={p.iconUrl} size={20} />
                </button>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">
                    {p.name}
                  </span>
                  {p.description && (
                    <span className="block truncate text-[12px] text-ink-subtle">
                      {p.description}
                    </span>
                  )}
                </span>
                {p.targetDate && (
                  <span className="shrink-0 font-mono text-[11px] text-ink-tertiary">
                    → {new Date(p.targetDate).toLocaleDateString()}
                  </span>
                )}
                <select
                  value={p.status}
                  onChange={(e) => void setStatus(p, e.target.value)}
                  disabled={busy === p.id}
                  aria-label={`Status for ${p.name}`}
                  className="rounded-sm border border-control bg-surface-1 px-1.5 py-1 font-mono text-[11px] text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() =>
                    void run(
                      `/api/projects/${p.id}`,
                      { method: "DELETE" },
                      "could not delete project",
                      p.id,
                    )
                  }
                  disabled={busy === p.id}
                  className="font-mono text-[11px] text-ink-subtle hover:text-danger disabled:opacity-50"
                >
                  delete
                </button>
              </div>
              {logoEdit === p.id && (
                <form
                  className="mt-2 flex items-center gap-2 pl-8"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveLogo(p);
                  }}
                >
                  <input
                    value={logoDraft[p.id] ?? ""}
                    onChange={(e) =>
                      setLogoDraft((d) => ({ ...d, [p.id]: e.target.value }))
                    }
                    placeholder="https://example.com/logo.svg"
                    aria-label={`Logo URL for ${p.name}`}
                    autoFocus
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded-sm border border-control bg-surface-1 px-2 py-1 font-mono text-[12px] text-ink placeholder:text-ink-disabled focus-visible:outline-2 focus-visible:outline-accent"
                  />
                  <button
                    type="submit"
                    disabled={busy === p.id}
                    className="rounded-sm bg-accent px-2.5 py-1 text-[12px] font-medium text-on-accent disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogoEdit(null)}
                    className="rounded-sm px-2 py-1 text-[12px] text-ink-subtle hover:text-ink"
                  >
                    Cancel
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}
