"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { apiFailure, isSecretsKeyMissing, type ApiFailure } from "@/lib/secrets-key";
import { SecretsKeyCallout } from "@/components/settings/secrets-key-callout";

export interface ProviderRow {
  id?: string;
  key: string;
  type: "github" | "google" | "oidc";
  label: string;
  clientId?: string;
  issuer?: string | null;
  scopes?: string[];
  source: "env" | "db";
  hasSecret?: boolean;
  envShadowed?: boolean;
}

const field =
  "mt-1 w-full rounded-sm border border-lining bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-lining-strong";
const label = "mt-4 block text-xs text-ink-subtle";

const TYPE_DEFAULTS: Record<string, { issuer?: string; scopes?: string }> = {
  github: {},
  google: { issuer: "https://accounts.google.com" },
  oidc: {},
};

export function ProviderPanel({ providers }: { providers: ProviderRow[] }) {
  const router = useRouter();
  const [type, setType] = useState<string>("github");
  const [pending, setPending] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProviderRow | null>(null);
  const [editing, setEditing] = useState<ProviderRow | null>(null);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setFailure(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/settings/providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        key: fd.get("key"),
        type: fd.get("type"),
        label: fd.get("label"),
        clientId: fd.get("clientId"),
        clientSecret: fd.get("clientSecret"),
        ...(fd.get("issuer") ? { issuer: fd.get("issuer") } : {}),
        scopes: String(fd.get("scopes") ?? "")
          .split(/[\s,]+/)
          .filter(Boolean),
      }),
    });
    setPending(false);
    if (res.ok) {
      (e.target as HTMLFormElement).reset();
      router.refresh();
    } else {
      setFailure(await apiFailure(res, "could not add provider"));
    }
  }

  async function test(p: ProviderRow) {
    if (!p.id) return;
    setTesting(p.id);
    const res = await fetch(`/api/settings/providers/${p.id}/test`, {
      method: "POST",
    });
    const d = (await res.json().catch(() => null)) as {
      ok?: boolean;
      status?: number;
      error?: { message?: string };
    } | null;
    setTesting(null);
    setTestResult((m) => ({
      ...m,
      [p.id!]: res.ok && d?.ok
        ? `reachable (HTTP ${d.status ?? "?"})`
        : (d?.error?.message ?? `HTTP ${res.status}`),
    }));
  }

  async function remove(p: ProviderRow) {
    setConfirmDelete(null);
    const res = await fetch(`/api/settings/providers/${p.id}`, {
      method: "DELETE",
    });
    if (res.ok) {
      router.refresh();
    } else {
      setFailure(await apiFailure(res, "could not delete provider"));
    }
  }

  async function saveEdit(e: React.FormEvent<HTMLFormElement>, p: ProviderRow) {
    e.preventDefault();
    setPending(true);
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`/api/settings/providers/${p.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        label: fd.get("label"),
        clientId: fd.get("clientId"),
        ...(fd.get("clientSecret") ? { clientSecret: fd.get("clientSecret") } : {}),
        ...(fd.get("issuer") ? { issuer: fd.get("issuer") } : {}),
      }),
    });
    setPending(false);
    if (res.ok) {
      setEditing(null);
      router.refresh();
    } else {
      setFailure(await apiFailure(res, "could not update provider"));
    }
  }

  const dbRows = providers.filter((p) => p.source === "db" && !p.envShadowed);
  const lastDbProvider = dbRows.length === 1 && providers.every((p) => p.source === "db" || p.envShadowed);

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-2">
      <form
        onSubmit={create}
        className="rounded-md border border-lining bg-surface-1 p-5"
      >
        <h2 className="text-sm font-semibold">Add provider</h2>
        <p className="mt-1 text-xs text-ink-subtle">
          Instance-wide sign-in. Env-defined providers take precedence over
          the same key.
        </p>

        {isSecretsKeyMissing(failure) ? (
          <div className="mt-3">
            <SecretsKeyCallout />
          </div>
        ) : (
          failure && (
            <p
              role="alert"
              className="mt-3 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted"
            >
              {failure.message}
            </p>
          )
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="p-key">
              Key
            </label>
            <input
              id="p-key"
              name="key"
              required
              pattern="[a-z0-9-]+"
              placeholder="corpidp"
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="p-type">
              Type
            </label>
            <select
              id="p-type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={field}
            >
              <option value="github">github</option>
              <option value="google">google</option>
              <option value="oidc">oidc</option>
            </select>
          </div>
        </div>

        <label className={label} htmlFor="p-label">
          Label (login button text)
        </label>
        <input id="p-label" name="label" required placeholder="Company SSO" className={field} />

        {(type === "oidc" || type === "google") && (
          <label className={label} htmlFor="p-issuer">
            Issuer (https, discovery-enabled)
            <input
              id="p-issuer"
              name="issuer"
              required={type === "oidc"}
              defaultValue={TYPE_DEFAULTS[type]?.issuer ?? ""}
              placeholder="https://idp.example.com"
              className={field}
            />
          </label>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label} htmlFor="p-cid">
              Client ID
            </label>
            <input id="p-cid" name="clientId" required className={field} />
          </div>
          <div>
            <label className={label} htmlFor="p-secret">
              Client secret
            </label>
            <input id="p-secret" name="clientSecret" type="password" required className={field} />
          </div>
        </div>

        {type === "oidc" && (
          <label className={label} htmlFor="p-scopes">
            Extra scopes (space-separated; openid is always requested)
          </label>
        )}
        {type === "oidc" && (
          <input id="p-scopes" name="scopes" placeholder="email profile" className={field} />
        )}

        <button
          type="submit"
          disabled={pending}
          className="mt-5 w-full rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
        >
          {pending ? "Saving…" : "Add provider"}
        </button>
      </form>

      <div className="rounded-md border border-lining bg-surface-1 p-5">
        <h2 className="text-sm font-semibold">Configured</h2>
        {providers.length === 0 ? (
          <p className="mt-3 text-sm text-ink-subtle">
            No providers — email/password sign-in only.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {providers.map((p) => (
              <li key={p.key} className="rounded-sm border border-lining-faint p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm font-medium text-ink">{p.label}</span>
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-ink-tertiary">
                      {p.type} · {p.key}
                    </span>
                    <span
                      className={`ml-2 rounded-sm px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                        p.source === "env"
                          ? "bg-surface-2 text-ink-subtle"
                          : "bg-accent/15 text-accent"
                      }`}
                    >
                      {p.source === "env" ? "env" : "db"}
                    </span>
                  </div>
                  {p.source === "db" && p.id && (
                    <div className="flex gap-1">
                      <button
                        onClick={() => test(p)}
                        disabled={testing === p.id}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink disabled:opacity-50"
                      >
                        {testing === p.id ? "testing…" : "test"}
                      </button>
                      <button
                        onClick={() => setEditing(p)}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                      >
                        edit
                      </button>
                      <button
                        onClick={() => setConfirmDelete(p)}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                      >
                        delete
                      </button>
                    </div>
                  )}
                </div>
                {p.source === "env" && (
                  <p className="mt-1 text-xs text-ink-tertiary">
                    configured by environment — edit via env vars
                  </p>
                )}
                {p.envShadowed && (
                  <p className="mt-1 text-xs text-ink-tertiary">
                    shadowed — an env provider owns this key
                  </p>
                )}
                {testResult[p.id ?? ""] && (
                  <p className="mt-1 text-xs text-ink-muted">
                    {testResult[p.id ?? ""]}
                  </p>
                )}
                {editing?.id === p.id && (
                  <form
                    onSubmit={(e) => saveEdit(e, p)}
                    className="mt-3 border-t border-lining-faint pt-3"
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <input
                        name="label"
                        defaultValue={p.label}
                        className={field}
                        aria-label="Label"
                      />
                      <input
                        name="clientId"
                        defaultValue={p.clientId}
                        className={field}
                        aria-label="Client ID"
                      />
                    </div>
                    {p.type !== "github" && (
                      <input
                        name="issuer"
                        defaultValue={p.issuer ?? ""}
                        placeholder="issuer"
                        className={field}
                        aria-label="Issuer"
                      />
                    )}
                    <input
                      name="clientSecret"
                      type="password"
                      placeholder="client secret — leave blank to keep"
                      className={field}
                      aria-label="Client secret"
                    />
                    <div className="mt-3 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-sm px-3 py-1.5 text-xs text-ink-subtle hover:bg-surface-2"
                      >
                        cancel
                      </button>
                      <button
                        type="submit"
                        disabled={pending}
                        className="rounded-sm bg-accent px-3 py-1.5 text-xs font-medium text-on-accent disabled:opacity-60"
                      >
                        save
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDelete && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-6"
        >
          <div className="w-full max-w-sm rounded-md border border-lining bg-surface-1 p-5">
            <h2 className="text-sm font-semibold">Delete provider</h2>
            <p className="mt-2 text-sm text-ink-subtle">
              Users who only sign in via {confirmDelete.label} will lose
              access.
              {lastDbProvider &&
                " This is the only configured provider — deleting it leaves the instance password-auth only."}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="rounded-sm px-3 py-1.5 text-sm text-ink-subtle hover:bg-surface-2"
              >
                cancel
              </button>
              <button
                onClick={() => remove(confirmDelete)}
                disabled={lastDbProvider}
                className="rounded-sm bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                delete
              </button>
            </div>
            {lastDbProvider && (
              <p className="mt-2 text-xs text-ink-subtle">
                Deletion blocked — configure another sign-in method first.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
