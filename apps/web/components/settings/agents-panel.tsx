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
  ghostBtn,
  labelCls,
  primaryBtn,
  type Scope,
} from "./ui";

interface AgentRow {
  id: string;
  name: string;
  harness: string;
}
interface KeyRow {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

const HARNESSES = ["claude-code", "codex", "cursor", "gemini-cli", "custom"];
const EXPIRY = [
  { v: "", label: "Workspace default" },
  { v: "30", label: "30 days" },
  { v: "90", label: "90 days" },
  { v: "365", label: "1 year" },
];

export function AgentsPanel({ canAdmin }: { canAdmin: boolean }) {
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/agents");
    if (!res.ok) {
      setError(await errorMessage(res, "could not load agents"));
      setAgents([]);
      return;
    }
    setAgents(((await res.json()) as { agents: AgentRow[] }).agents);
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
    const res = await fetch("/api/settings/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: fd.get("name"), harness: fd.get("harness") }),
    });
    setPending(false);
    if (res.ok) {
      form.reset();
      await load();
    } else {
      setError(
        res.status === 409
          ? "An agent with that name already exists in this workspace."
          : await errorMessage(res, "could not create agent"),
      );
    }
  }

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <div>
        <Panel
          id="new-agent"
          title="New agent identity"
          hint="An identity is who shows up in the activity feed. Give it keys to let a tool act as it. Agent keys can never approve a review or mint other credentials; only people do."
        >
          {canAdmin ? (
            <form onSubmit={create}>
              <ErrorLine message={error} />
              <label className={labelCls} htmlFor="agent-name">
                Name (lowercase, digits, dashes)
              </label>
              <input
                id="agent-name"
                name="name"
                required
                maxLength={80}
                pattern="[a-z0-9][a-z0-9\-]*"
                title="lowercase letters, digits and dashes"
                autoComplete="off"
                className={field}
              />
              <label className={labelCls} htmlFor="agent-harness">
                Harness
              </label>
              <input
                id="agent-harness"
                name="harness"
                required
                list="harness-options"
                defaultValue="claude-code"
                maxLength={80}
                className={field}
              />
              <datalist id="harness-options">
                {HARNESSES.map((h) => (
                  <option key={h} value={h} />
                ))}
              </datalist>
              <button type="submit" disabled={pending} className={`${primaryBtn} mt-5 w-full`}>
                {pending ? "Creating…" : "Create agent"}
              </button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-ink-subtle">
              Creating agents and keys requires an admin.
            </p>
          )}
        </Panel>
      </div>

      <div className="min-w-0 space-y-4">
        {agents === null && (
          <p role="status" className="text-sm text-ink-subtle">
            Loading agents…
          </p>
        )}
        {agents?.length === 0 && (
          <Panel title="No agents yet">
            <p className="mt-2 text-sm text-ink-subtle">
              Create an identity, then issue it a key. New keys are read-only unless
              you explicitly add write.
            </p>
          </Panel>
        )}
        {agents?.map((a) => (
          <AgentCard key={a.id} agent={a} canAdmin={canAdmin} />
        ))}
      </div>
    </div>
  );
}

function AgentCard({ agent, canAdmin }: { agent: AgentRow; canAdmin: boolean }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopes, setScopes] = useState<Scope[]>(["read"]);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [rotating, setRotating] = useState<KeyRow | null>(null);
  const [grace, setGrace] = useState("0");
  const [pending, setPending] = useState(false);
  const base = `/api/settings/agents/${agent.id}/keys`;

  const load = useCallback(async () => {
    const res = await fetch(base);
    if (!res.ok) {
      setError(await errorMessage(res, "could not load keys"));
      setKeys([]);
      return;
    }
    setKeys(((await res.json()) as { keys: KeyRow[] }).keys);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  async function issue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setPending(true);
    setError(null);
    const fd = new FormData(form);
    const days = String(fd.get("expiresInDays") ?? "");
    const res = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: fd.get("name") || "default",
        scopes,
        ...(days ? { expiresInDays: Number(days) } : {}),
      }),
    });
    setPending(false);
    if (res.ok) {
      const d = (await res.json()) as { key: string };
      setSecret(d.key);
      form.reset();
      setScopes(["read"]);
      await load();
    } else {
      setError(await errorMessage(res, "could not issue key"));
    }
  }

  async function revoke(k: KeyRow) {
    setRevoking(null);
    const res = await fetch(`${base}/${k.id}`, { method: "DELETE" });
    if (res.ok) await load();
    else setError(await errorMessage(res, "could not revoke key"));
  }

  async function rotate(k: KeyRow) {
    setRotating(null);
    setError(null);
    const res = await fetch(`${base}/${k.id}/rotate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ graceSeconds: Number(grace) }),
    });
    setGrace("0");
    if (res.ok) {
      setSecret(((await res.json()) as { key: string }).key);
      await load();
    } else setError(await errorMessage(res, "could not rotate key"));
  }

  const id = `agent-${agent.id}`;
  return (
    <section
      aria-labelledby={id}
      className="rounded-md border border-lining bg-surface-1 p-5"
    >
      <div className="flex items-baseline gap-2">
        <h2 id={id} className="font-mono text-sm font-semibold">
          {agent.name}
        </h2>
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
          {agent.harness}
        </span>
      </div>

      <ErrorLine message={error} />
      {secret && (
        <SecretReveal label="API key" value={secret} onDismiss={() => setSecret(null)} />
      )}

      <div className="mt-3 overflow-x-auto">
        {keys === null ? (
          <p role="status" className="text-sm text-ink-subtle">
            Loading keys…
          </p>
        ) : keys.length === 0 ? (
          <p className="text-sm text-ink-subtle">No keys issued.</p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Keys for {agent.name}</caption>
            <thead>
              <tr className="border-b border-lining-faint text-left font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
                <th className="pb-2 pr-3 font-normal">Key</th>
                <th className="pb-2 pr-3 font-normal">Scopes</th>
                <th className="pb-2 pr-3 font-normal">Expires</th>
                <th className="pb-2 pr-3 font-normal">Last used</th>
                {canAdmin && (
                  <th className="pb-2 font-normal">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-lining-faint">
                  <td className="py-2 pr-3 text-ink">
                    {k.name}
                    <span className="block font-mono text-[11px] text-ink-tertiary">
                      tly_agt_…
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <ScopeBadges scopes={k.scopes} />
                  </td>
                  <td className="py-2 pr-3 text-ink-muted">
                    <Time value={k.expiresAt} empty="never" />
                    {k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now() && (
                      <span className="ml-1 font-mono text-[11px] uppercase text-ink-tertiary">
                        expired
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-ink-muted"><Time value={k.lastUsedAt} /></td>
                  {canAdmin && (
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => setRotating(k)}
                        aria-label={`Rotate key ${k.name}`}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                      >
                        rotate
                      </button>
                      <button
                        type="button"
                        onClick={() => setRevoking(k)}
                        aria-label={`Revoke key ${k.name}`}
                        className="rounded-sm px-2 py-1 text-xs text-ink-subtle hover:bg-surface-2 hover:text-ink"
                      >
                        revoke
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {canAdmin && (
        <form onSubmit={issue} className="mt-4 border-t border-lining-faint pt-2">
          <h3 className="mt-3 text-xs font-semibold text-ink-muted">Issue a key</h3>
          <div className="grid gap-x-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor={`${id}-kname`}>
                Key name
              </label>
              <input
                id={`${id}-kname`}
                name="name"
                maxLength={80}
                placeholder="laptop, ci, …"
                autoComplete="off"
                className={field}
              />
            </div>
            <div>
              <label className={labelCls} htmlFor={`${id}-exp`}>
                Expires
              </label>
              <select id={`${id}-exp`} name="expiresInDays" className={field}>
                {EXPIRY.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <ScopePicker name={`${id}-scope`} value={scopes} onChange={setScopes} />
          <button type="submit" disabled={pending} className={`${ghostBtn} mt-4`}>
            {pending ? "Issuing…" : "Issue key"}
          </button>
        </form>
      )}

      {rotating && (
        <ConfirmDialog
          title="Rotate key"
          confirmLabel="Rotate key"
          onCancel={() => {
            setRotating(null);
            setGrace("0");
          }}
          onConfirm={() => rotate(rotating)}
        >
          Issue a replacement for “{rotating.name}”. The new key is shown once.
          <label className={labelCls} htmlFor={`${id}-grace`}>
            Old key stops working
          </label>
          <select
            id={`${id}-grace`}
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
            className={field}
          >
            <option value="0">Immediately</option>
            <option value="3600">After 1 hour</option>
            <option value="86400">After 24 hours</option>
          </select>
        </ConfirmDialog>
      )}

      {revoking && (
        <ConfirmDialog
          title="Revoke key"
          confirmLabel="Revoke key"
          onCancel={() => setRevoking(null)}
          onConfirm={() => revoke(revoking)}
        >
          Revoke “{revoking.name}” for {agent.name}? Anything using it stops working
          immediately. This cannot be undone.
        </ConfirmDialog>
      )}
    </section>
  );
}
