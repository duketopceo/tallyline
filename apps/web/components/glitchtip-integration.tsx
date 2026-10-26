"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  buildConfigBody,
  revealFrom,
  rowsFromMap,
  type MapRow,
  type Reveal,
} from "@/lib/glitchtip-form";

export interface GlitchtipStatus {
  configured: boolean;
  enabled: boolean;
  tokenLast4: string;
  glitchtipHost: string | null;
  projectMap: Record<string, string>;
  defaultTeamKey: string | null;
  lastReceivedAt: string | null;
}

export interface TeamOption {
  key: string;
  name: string;
}

const ghostButtonClass =
  "rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink";

const fieldClass =
  "h-8 rounded-sm border border-lining bg-surface-2 px-2 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-lining-strong disabled:opacity-50";

export function GlitchtipPanel({
  status,
  teams,
}: {
  status: GlitchtipStatus | null;
  teams: TeamOption[];
}) {
  const router = useRouter();
  const [rows, setRows] = useState<MapRow[]>(() => rowsFromMap(status?.projectMap));
  const [dflt, setDflt] = useState(status?.defaultTeamKey ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [copied, setCopied] = useState(false);

  function updateRow(index: number, patch: Partial<MapRow>) {
    setRows(rows.map((row, j) => (j === index ? { ...row, ...patch } : row)));
  }

  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown | null> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/settings/glitchtip${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? "request failed");
        return null;
      }
      return data ?? {};
    } catch {
      setError("could not reach the server");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const built = buildConfigBody(rows, dflt);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    const data = await call("PUT", "", built.body);
    if (!data) return;
    // creation answers with the one-time URL; keep it in state, not props
    const shown = revealFrom(data);
    if (shown) setReveal(shown);
    router.refresh();
  }

  async function rotate() {
    const data = await call("POST", "/rotate");
    if (!data) return;
    setReveal(revealFrom(data));
    router.refresh();
  }

  async function remove() {
    if (!confirm("Delete the GlitchTip integration? Its webhook URL stops working.")) return;
    if (await call("DELETE", "")) {
      setReveal(null);
      router.refresh();
    }
  }

  async function copy() {
    if (!reveal) return;
    try {
      await navigator.clipboard.writeText(reveal.webhookUrl);
      setCopied(true);
    } catch {
      setError("could not copy; select the URL and copy it by hand");
    }
  }

  const configured = status?.configured === true;

  return (
    <section aria-labelledby="glitchtip-heading" className="border-t border-lining-faint p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 id="glitchtip-heading" className="text-sm font-semibold">
          GlitchTip
        </h2>
        <span className="font-mono text-[11px] text-ink-tertiary">
          {configured
            ? `${status.enabled ? "on" : "off"} · secret …${status.tokenLast4}${
                status.lastReceivedAt ? ` · last alert ${status.lastReceivedAt.slice(0, 16).replace("T", " ")}` : " · no alerts yet"
              }`
            : "not set up"}
        </span>
      </div>
      <p className="mb-3 max-w-prose text-sm text-ink-subtle">
        Alerts from GlitchTip become triage issues on the team mapped to their project.
        Point a GlitchTip alert recipient (type Webhook or Slack) at the URL shown once
        after setup.
      </p>

      {error && (
        <p role="alert" className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted">
          {error}
        </p>
      )}

      {reveal && (
        <div className="mb-4 rounded-sm border border-lining-strong bg-surface-2 p-3">
          <p className="mb-2 text-sm text-ink">
            Webhook URL. It is shown once; copy it into GlitchTip now.
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={reveal.webhookUrl}
              aria-label="GlitchTip webhook URL"
              onFocus={(e) => e.currentTarget.select()}
              className={`${fieldClass} w-full font-mono text-[12px]`}
            />
            <button
              onClick={copy}
              className={ghostButtonClass}
            >
              {copied ? "copied" : "copy"}
            </button>
          </div>
        </div>
      )}

      <table className="mb-3 w-full max-w-xl text-sm">
        <thead>
          <tr className="border-b border-lining-faint text-left font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
            <th className="pb-2 font-normal">GlitchTip project</th>
            <th className="pb-2 font-normal">Team</th>
            <th className="pb-2 font-normal" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-lining-faint">
              <td className="py-2 pr-3">
                <input
                  value={r.name}
                  aria-label={`GlitchTip project name, row ${i + 1}`}
                  placeholder="project name"
                  onChange={(e) => updateRow(i, { name: e.target.value })}
                  className={`${fieldClass} w-full font-mono`}
                />
              </td>
              <td className="py-2 pr-3">
                <select
                  value={r.team}
                  aria-label={`Team for row ${i + 1}`}
                  onChange={(e) => updateRow(i, { team: e.target.value })}
                  className={fieldClass}
                >
                  <option value="">choose team</option>
                  {teams.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.key} · {t.name}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 text-right">
                <button
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  aria-label={`Remove row ${i + 1}`}
                  className={ghostButtonClass}
                >
                  remove
                </button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="py-4 text-center text-ink-tertiary">
                no projects mapped
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => setRows([...rows, { name: "", team: "" }])}
          className={ghostButtonClass}
        >
          add project
        </button>
        <label className="flex items-center gap-2 text-sm text-ink-subtle">
          Default team for unmapped projects
          <select
            value={dflt}
            onChange={(e) => setDflt(e.target.value)}
            aria-label="Default team for unmapped projects"
            className={fieldClass}
          >
            <option value="">reject them</option>
            {teams.map((t) => (
              <option key={t.key} value={t.key}>
                {t.key} · {t.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-sm border border-lining px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          {configured ? "Save mapping" : "Set up GlitchTip"}
        </button>
        {configured && (
          <>
            <button
              onClick={rotate}
              disabled={busy}
              className={`${ghostButtonClass} disabled:opacity-50`}
            >
              rotate secret
            </button>
            <button
              onClick={remove}
              disabled={busy}
              className={`${ghostButtonClass} disabled:opacity-50`}
            >
              delete
            </button>
          </>
        )}
      </div>
    </section>
  );
}
