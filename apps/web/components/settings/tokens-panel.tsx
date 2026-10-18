"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ConfirmDialog,
  ErrorLine,
  Panel,
  ScopeBadges,
  ScopePicker,
  SecretReveal,
  errorMessage,
  field,
  Time,
  labelCls,
  primaryBtn,
  type Scope,
} from "./ui";

interface TokenRow {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function TokensPanel({ canAdmin }: { canAdmin: boolean }) {
  const [tokens, setTokens] = useState<TokenRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<TokenRow | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/tokens");
    if (!res.ok) {
      setError(await errorMessage(res, "could not load tokens"));
      setTokens([]);
      return;
    }
    setTokens(((await res.json()) as { tokens: TokenRow[] }).tokens);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    const expires = String(fd.get("expiresAt") ?? "");
    const res = await fetch("/api/settings/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: fd.get("name"),
        scopes,
        // end of the chosen day, UTC
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59Z`).toISOString() } : {}),
      }),
    });
    setPending(false);
    if (res.ok) {
      setSecret(((await res.json()) as { token: string }).token);
      form.reset();
      setScopes(["read"]);
      await load();
    } else {
      setError(await errorMessage(res, "could not create token"));
    }
  }

  async function revoke(t: TokenRow) {
    setRevoking(null);
    const res = await fetch(`/api/settings/tokens/${t.id}`, { method: "DELETE" });
    if (res.ok) await load();
    else setError(await errorMessage(res, "could not revoke token"));
  }

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <Panel
        id="new-token"
        title="New personal access token"
        hint="Acts as you, in this workspace, for scripts and CLIs. Prefer an agent key for automation that should be attributed to an agent."
      >
        {canAdmin ? (
          <form onSubmit={create}>
            <ErrorLine message={error} />
            <label className={labelCls} htmlFor="tok-name">
              Name
            </label>
            <input
              id="tok-name"
              name="name"
              required
              maxLength={120}
              placeholder="deploy script"
              autoComplete="off"
              className={field}
            />
            <ScopePicker name="tok-scope" value={scopes} onChange={setScopes} />
            <label className={labelCls} htmlFor="tok-exp">
              Expires on (optional)
            </label>
            <input id="tok-exp" name="expiresAt" type="date" className={field} />
            <button type="submit" disabled={pending} className={`${primaryBtn} mt-5 w-full`}>
              {pending ? "Creating…" : "Create token"}
            </button>
          </form>
        ) : (
          <p className="mt-3 text-sm text-ink-subtle">
            Creating tokens requires an admin.
          </p>
        )}
        {secret && (
          <SecretReveal label="token" value={secret} onDismiss={() => setSecret(null)} />
        )}
      </Panel>

      <Panel id="your-tokens" title="Your tokens">
        {!canAdmin && <ErrorLine message={error} />}
        {tokens === null ? (
          <p role="status" className="mt-3 text-sm text-ink-subtle">
            Loading tokens…
          </p>
        ) : tokens.length === 0 ? (
          <p className="mt-3 text-sm text-ink-subtle">No tokens yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Your personal access tokens</caption>
              <thead>
                <tr className="border-b border-lining-faint text-left font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
                  <th className="pb-2 pr-3 font-normal">Name</th>
                  <th className="pb-2 pr-3 font-normal">Scopes</th>
                  <th className="pb-2 pr-3 font-normal">Expires</th>
                  <th className="pb-2 pr-3 font-normal">Last used</th>
                  <th className="pb-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-b border-lining-faint">
                    <td className="py-2 pr-3 text-ink">{t.name}</td>
                    <td className="py-2 pr-3">
                      <ScopeBadges scopes={t.scopes} />
                    </td>
                    <td className="py-2 pr-3 text-ink-muted"><Time value={t.expiresAt} /></td>
                    <td className="py-2 pr-3 text-ink-muted"><Time value={t.lastUsedAt} /></td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setRevoking(t)}
                        aria-label={`Revoke token ${t.name}`}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                      >
                        revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {revoking && (
        <ConfirmDialog
          title="Revoke token"
          confirmLabel="Revoke token"
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke(revoking)}
        >
          Revoke “{revoking.name}”? Anything using it stops working immediately.
        </ConfirmDialog>
      )}
    </div>
  );
}
