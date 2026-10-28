"use client";

import { useEffect, useRef, useState } from "react";
import { parseUserCode, type ApprovableWorkspace } from "@/lib/device-code";

interface Pending {
  clientName: string;
  requestIp: string | null;
  requestedAt: string;
  expiresAt: string;
}

type Step =
  | { kind: "enter" }
  | { kind: "review"; code: string; pending: Pending }
  | { kind: "done"; decision: "approve" | "deny"; workspace: string };

async function errorOf(res: Response, fallback: string): Promise<string> {
  const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return d?.error?.message ?? fallback;
}

export function DeviceForm({
  initialCode,
  workspaces,
  emailVerified,
}: {
  initialCode: string;
  workspaces: ApprovableWorkspace[];
  emailVerified: boolean;
}) {
  const [input, setInput] = useState(initialCode);
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [workspace, setWorkspace] = useState(workspaces[0]?.slug ?? "");
  const [access, setAccess] = useState<"read" | "write">("write");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoLooked = useRef(false);

  const first = workspaces[0]?.slug;

  async function lookup(raw: string) {
    const code = parseUserCode(raw);
    if (!code) {
      setError("That doesn't look like a code. It has eight letters and numbers, like BCDF-GHJK.");
      return;
    }
    if (!first) return;
    setPending(true);
    setError(null);
    const res = await fetch(`/api/device/${encodeURIComponent(first)}/${encodeURIComponent(code)}`, {
      cache: "no-store",
    });
    setPending(false);
    if (res.ok) {
      setStep({ kind: "review", code, pending: (await res.json()) as Pending });
    } else if (res.status === 404) {
      setError("That code isn't valid or has expired. Run tallyline connect again for a fresh one.");
    } else {
      setError(await errorOf(res, "Could not check that code. Try again."));
    }
  }

  // arriving from the CLI with the code already in the address: check it straight away
  useEffect(() => {
    if (initialCode && first && !autoLooked.current) {
      autoLooked.current = true;
      void lookup(initialCode);
    }
  }, []);

  async function decide(approve: boolean) {
    if (step.kind !== "review") return;
    setPending(true);
    setError(null);
    const res = await fetch(`/api/device/${encodeURIComponent(workspace)}/${encodeURIComponent(step.code)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: approve ? "approve" : "deny",
        ...(approve ? { scopes: access === "write" ? ["read", "write"] : ["read"] } : {}),
      }),
    });
    setPending(false);
    if (res.ok) {
      setStep({ kind: "done", decision: approve ? "approve" : "deny", workspace });
      return;
    }
    setError(
      res.status === 404
        ? "That code expired or was already used. Run tallyline connect again for a fresh one."
        : await errorOf(res, "Could not complete this request."),
    );
  }

  if (workspaces.length === 0) {
    return (
      <>
        <h1 className="mt-2 text-[17px] font-semibold">Ask an admin to connect the CLI</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          Connecting the command line needs an admin or owner of a workspace, because it creates a
          personal access token. Ask one to approve this, or create a token yourself if you are
          allowed to in Settings.
        </p>
      </>
    );
  }

  if (step.kind === "done") {
    const ws = workspaces.find((w) => w.slug === step.workspace)?.name ?? step.workspace;
    return (
      <>
        <h1 className="mt-2 text-[17px] font-semibold">
          {step.decision === "approve" ? "You're connected" : "Request denied"}
        </h1>
        <p className="mt-2 text-sm text-ink-subtle" role="status">
          {step.decision === "approve"
            ? `The command line is now signed in to ${ws}. You can close this tab and go back to your terminal.`
            : "Nothing was connected. You can close this tab."}
        </p>
      </>
    );
  }

  const blockedReason = !emailVerified ? "Confirm your email before connecting the command line." : null;

  if (step.kind === "enter") {
    return (
      <>
        <h1 className="mt-2 text-[17px] font-semibold">Connect the command line</h1>
        <p className="mt-2 text-sm text-ink-subtle">
          Enter the code your terminal is showing.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void lookup(input);
          }}
        >
          <label className="mt-4 block text-sm font-medium" htmlFor="code">
            Code
          </label>
          <input
            id="code"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="BCDF-GHJK"
            className="mt-1 w-full rounded-sm border border-lining bg-surface-1 px-2 py-2 font-mono text-sm tracking-widest"
          />
          {error && (
            <p role="alert" className="mt-3 text-sm text-urgent">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={pending || input.trim() === ""}
            className="mt-4 w-full rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
          >
            Continue
          </button>
        </form>
      </>
    );
  }

  return (
    <>
      <h1 className="mt-2 text-[17px] font-semibold">Connect {step.pending.clientName}?</h1>
      <p className="mt-2 text-sm text-ink-subtle">
        This will sign the command line in to Tallyline as you. Only continue if you just started
        this from your own terminal and the code there is{" "}
        <strong className="font-mono text-ink">{step.code}</strong>.
      </p>
      {step.pending.requestIp && (
        <p className="mt-2 text-xs text-ink-subtle">
          Requested from {step.pending.requestIp}. The code expires at{" "}
          {new Date(step.pending.expiresAt).toLocaleTimeString()}.
        </p>
      )}
      {workspaces.length > 1 && (
        <>
          <label className="mt-4 block text-sm font-medium" htmlFor="ws">
            Workspace
          </label>
          <select
            id="ws"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            className="mt-1 w-full rounded-sm border border-lining bg-surface-1 px-2 py-2 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.slug} value={w.slug}>
                {w.name}
              </option>
            ))}
          </select>
        </>
      )}
      <fieldset className="mt-4">
        <legend className="text-sm font-medium">Access</legend>
        <label className="mt-1 flex items-start gap-2 text-sm">
          <input type="radio" name="access" checked={access === "read"} onChange={() => setAccess("read")} />
          <span>Read only: view issues, agents, members and activity</span>
        </label>
        <label className="mt-1 flex items-start gap-2 text-sm">
          <input type="radio" name="access" checked={access === "write"} onChange={() => setAccess("write")} />
          <span>Read and write: also create, update, triage and comment</span>
        </label>
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
        The token lasts 90 days. You can revoke it any time in Settings, Tokens.
      </p>
    </>
  );
}
