"use client";

import { useCallback, useEffect, useState } from "react";
import { dangerBtn, errorMessage, Notice, Panel } from "@/components/account/ui";

interface Identity {
  id: string;
  provider: string;
  email: string | null;
  relayEmail: boolean;
  linkedAt: string;
}

const LABEL: Record<string, string> = { apple: "Apple", github: "GitHub", google: "Google", oidc: "SSO" };

// Settings > Account > Sign-in methods: linked providers, with the rule that
// the last remaining sign-in method cannot be removed.
export function LinkedIdentities() {
  const [rows, setRows] = useState<Identity[] | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/account/identities", { cache: "no-store" });
    if (!res.ok) {
      setError(await errorMessage(res, "Could not load your sign-in methods."));
      return;
    }
    const d = (await res.json()) as { identities: Identity[]; hasPassword: boolean };
    setRows(d.identities);
    setHasPassword(d.hasPassword);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = (rows?.length ?? 0) + (hasPassword ? 1 : 0);

  async function disconnect(id: string) {
    setBusy(id);
    setError(null);
    const res = await fetch(`/api/account/identities/${id}`, { method: "DELETE" });
    setBusy(null);
    if (!res.ok) {
      setError(await errorMessage(res, "Could not disconnect that sign-in method."));
      return;
    }
    await load();
  }

  return (
    <Panel title="Sign-in methods" hint="Providers you can sign in with. You always keep at least one.">
      <ul className="mt-3 divide-y divide-lining text-body">
        {hasPassword && (
          <li className="flex items-center justify-between py-2">
            <span className="text-ink">Email and password</span>
          </li>
        )}
        {rows?.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="text-ink">{LABEL[r.provider] ?? r.provider}</span>
              <span className="ml-2 text-ink-subtle">
                linked {new Date(r.linkedAt).toLocaleDateString()}
                {r.relayEmail && " · private relay email"}
              </span>
            </span>
            <button
              type="button"
              className={dangerBtn}
              disabled={busy === r.id || total <= 1}
              title={total <= 1 ? "This is your only sign-in method" : undefined}
              onClick={() => disconnect(r.id)}
            >
              {busy === r.id ? "Disconnecting…" : "Disconnect"}
            </button>
          </li>
        ))}
        {rows?.length === 0 && !hasPassword && <li className="py-2 text-ink-subtle">None</li>}
      </ul>
      {error && <div className="mt-3"><Notice tone="error" title={error} /></div>}
    </Panel>
  );
}
