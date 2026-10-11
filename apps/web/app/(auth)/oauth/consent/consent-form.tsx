"use client";

import { useState } from "react";

export interface ConsentView {
  requestId: string;
  csrf: string;
  client: { id: string; name: string; kind: "dcr" | "cimd" };
  redirectUri: string;
  redirectHost: string;
  loopbackOnly: boolean;
  scopes: ("read" | "write")[];
  workspaces: { slug: string; name: string; role: string }[];
  emailVerified?: boolean;
  unavailableReason?: string | null;
}

// only http(s) URLs are ever navigated to; the API already pinned this to the
// client's registered redirect URI
function safeNavigate(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  } catch {
    return false;
  }
  window.location.assign(url);
  return true;
}

export function ConsentForm({ view }: { view: ConsentView }) {
  const canWrite = view.scopes.includes("write");
  const [workspace, setWorkspace] = useState(view.workspaces[0]?.slug ?? "");
  const [access, setAccess] = useState<"read" | "write">(canWrite ? "write" : "read");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the API refuses approval until the email is confirmed; say why up front
  const blockedReason =
    view.emailVerified === false
      ? (view.unavailableReason ?? "Confirm your email before connecting an app.")
      : null;

  async function decide(approve: boolean) {
    setPending(true);
    setError(null);
    const res = await fetch(`/api/oauth/consent/${encodeURIComponent(view.requestId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approve,
        csrf: view.csrf,
        ...(approve
          ? { workspace, scopes: access === "write" ? ["read", "write"] : ["read"] }
          : {}),
      }),
    });
    const data = (await res.json().catch(() => null)) as
      | { redirectTo?: string; error?: { message?: string } }
      | null;
    if (res.ok && data?.redirectTo && safeNavigate(data.redirectTo)) return;
    setPending(false);
    setError(data?.error?.message ?? "could not complete this request");
  }

  if (view.workspaces.length === 0) {
    return (
      <>
        <h1 className="mt-2 text-[17px] font-semibold">No workspace to connect</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          Your account is not a member of any workspace.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 className="mt-2 text-[17px] font-semibold">
        Connect {view.client.name} to Tallyline
      </h1>
      <p className="mt-2 text-sm text-ink-subtle">
        This app will act in the workspace you choose, as an agent connected by
        you. It returns to <strong className="text-ink">{view.redirectHost}</strong>.
      </p>
      {view.loopbackOnly && (
        <p role="alert" className="mt-3 rounded-sm border border-lining p-2 text-sm text-ink-subtle">
          This app runs on your own computer. Only continue if you started this
          connection yourself.
        </p>
      )}
      <label className="mt-4 block text-sm font-medium" htmlFor="ws">
        Workspace
      </label>
      <select
        id="ws"
        value={workspace}
        onChange={(e) => setWorkspace(e.target.value)}
        className="mt-1 w-full rounded-sm border border-lining bg-surface-1 px-2 py-2 text-sm"
      >
        {view.workspaces.map((w) => (
          <option key={w.slug} value={w.slug}>
            {w.name}
          </option>
        ))}
      </select>
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Access</legend>
        <label className="mt-1 flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="access"
            checked={access === "read"}
            onChange={() => setAccess("read")}
          />
          <span>Read only: view issues, agents, members and activity</span>
        </label>
        {canWrite && (
          <label className="mt-1 flex items-start gap-2 text-sm">
            <input
              type="radio"
              name="access"
              checked={access === "write"}
              onChange={() => setAccess("write")}
            />
            <span>Read and write: also create, update, triage and comment</span>
          </label>
        )}
      </fieldset>
      {blockedReason && (
        <p role="alert" className="mt-3 rounded-sm border border-lining p-2 text-sm text-ink-subtle">
          {blockedReason}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-urgent">
          {error}
        </p>
      )}
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          disabled={pending || !workspace || blockedReason !== null}
          onClick={() => void decide(true)}
          className="flex-1 rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void decide(false)}
          className="flex-1 rounded-sm border border-lining px-3 py-2 text-sm font-medium"
        >
          Deny
        </button>
      </div>
      <p className="mt-3 text-xs text-ink-subtle">
        You can revoke this connection at any time in Settings, Agents and keys.
      </p>
    </>
  );
}
