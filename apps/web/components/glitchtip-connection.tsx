"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { syncStatusText } from "@/lib/glitchtip-errors";

export interface GlitchtipConnectionStatus {
  baseUrl: string;
  tokenLast4: string;
  status: string | null;
  lastCheckedAt: string | null;
}

const fieldClass =
  "h-8 w-full rounded-sm border border-lining bg-surface-2 px-2 text-body text-ink outline-none placeholder:text-ink-tertiary focus:border-lining-strong disabled:opacity-50";

// Connect GlitchTip once per workspace so projects can show their error feed.
// The token is sent once and never shown again; only its last four characters.
export function GlitchtipConnectionPanel({ connection }: { connection: GlitchtipConnectionStatus | null }) {
  const router = useRouter();
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function call(method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/glitchtip/connection", {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!res.ok) {
        setError(data?.error?.message ?? "That did not work. Nothing was changed.");
        return false;
      }
      return true;
    } catch {
      setError("Could not reach the server. Nothing was changed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!baseUrl.trim()) {
      setError("Enter the address of your GlitchTip server.");
      return;
    }
    if (!connection && !token.trim()) {
      setError("Enter an API token from GlitchTip.");
      return;
    }
    if (await call("PUT", { baseUrl: baseUrl.trim(), ...(token.trim() ? { token: token.trim() } : {}) })) {
      setToken("");
      router.refresh();
    }
  }

  async function disconnect() {
    if (!confirm("Disconnect GlitchTip? Projects keep their mapping but stop showing errors.")) return;
    if (await call("DELETE")) router.refresh();
  }

  return (
    <section aria-labelledby="glitchtip-feed-heading" className="border-t border-lining-faint p-4">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 id="glitchtip-feed-heading" className="text-sm font-semibold">
          GlitchTip error feed
        </h2>
        <span className="font-mono text-micro text-ink-tertiary">
          {connection ? `token …${connection.tokenLast4} · ${syncStatusText(connection.status)}` : "not connected"}
        </span>
      </div>
      <p className="mb-3 max-w-prose text-sm text-ink-subtle">
        Connect your GlitchTip server so each project can show its production errors. Then open a
        project and choose which GlitchTip project it reads. The token is stored sealed and is
        never shown again.
      </p>
      {error && (
        <p role="alert" className="mb-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted">
          {error}
        </p>
      )}
      <div className="mb-3 grid max-w-xl gap-3">
        <label className="flex flex-col gap-1 text-xs text-ink-subtle">
          GlitchTip address
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://glitchtip.example.com"
            autoComplete="off"
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink-subtle">
          API token {connection ? "(leave empty to keep the saved one)" : ""}
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            className={fieldClass}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={busy}
          className="rounded-sm border border-lining px-3 py-1.5 text-sm text-ink hover:bg-surface-2 disabled:opacity-50"
        >
          {connection ? "Save connection" : "Connect GlitchTip"}
        </button>
        {connection && (
          <button
            onClick={disconnect}
            disabled={busy}
            className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-50"
          >
            disconnect
          </button>
        )}
      </div>
    </section>
  );
}
