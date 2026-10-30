"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ConfirmDialog,
  ErrorLine,
  Notice,
  Panel,
  dangerBtn,
  errorMessage,
  field,
  ghostBtn,
  labelCls,
  primaryBtn,
} from "./ui";

interface ProviderView {
  source: "workspace" | "environment";
  kind: "openrouter" | "openai_compatible";
  label: string;
  baseUrl: string | null;
  model: string;
  hasKey: boolean;
  monthlyCapCents: number | null;
  editable: boolean;
}

interface ProviderState {
  provider: ProviderView | null;
  defaultMonthlyCapCents: number;
  usage: { periodEnd: string; spentCents: number; calls: number };
}

type TestResult = { ok: boolean; model?: string; message?: string; ms: number };

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function AiProviderPanel() {
  const [state, setState] = useState<ProviderState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/settings/ai/provider");
    if (!res.ok) {
      setError(await errorMessage(res, "could not load the AI provider"));
      return;
    }
    setState((await res.json()) as ProviderState);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function connectOpenRouter() {
    setPending("connect");
    setError(null);
    const res = await fetch("/api/settings/ai/openrouter/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "redirect" }),
    });
    if (!res.ok) {
      setPending(null);
      setError(await errorMessage(res, "could not start connecting OpenRouter"));
      return;
    }
    const { authUrl } = (await res.json()) as { authUrl: string };
    window.location.assign(authUrl);
  }

  async function saveCompatible(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const apiKey = String(fd.get("apiKey") ?? "");
    setPending("save");
    setError(null);
    const res = await fetch("/api/settings/ai/provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "openai_compatible",
        label: String(fd.get("label") ?? "").trim() || "OpenAI-compatible",
        baseUrl: String(fd.get("baseUrl") ?? "").trim(),
        model: String(fd.get("model") ?? "").trim(),
        // blank = keep the stored key
        ...(apiKey ? { apiKey } : {}),
      }),
    });
    setPending(null);
    if (res.ok) {
      form.reset();
      await load();
    } else {
      setError(await errorMessage(res, "could not save the endpoint"));
    }
  }

  async function saveCap(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const p = state?.provider;
    if (!p?.editable) return;
    const raw = String(new FormData(e.currentTarget).get("cap") ?? "").trim();
    const cents = raw === "" ? null : Math.round(Number(raw) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 0)) {
      setError("enter a dollar amount, or leave it blank for no limit");
      return;
    }
    setPending("cap");
    setError(null);
    const res = await fetch("/api/settings/ai/provider", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: p.kind,
        label: p.label,
        model: p.model,
        ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
        monthlyCapCents: cents,
      }),
    });
    setPending(null);
    if (res.ok) await load();
    else setError(await errorMessage(res, "could not change the limit"));
  }

  async function runTest() {
    setPending("test");
    setTest(null);
    const res = await fetch("/api/settings/ai/provider/test", { method: "POST" });
    setPending(null);
    if (res.ok) setTest((await res.json()) as TestResult);
    else setError(await errorMessage(res, "could not run the test"));
    await load();
  }

  async function disconnect() {
    setConfirmDisconnect(false);
    setPending("disconnect");
    const res = await fetch("/api/settings/ai/provider", { method: "DELETE" });
    setPending(null);
    setTest(null);
    if (res.ok) await load();
    else setError(await errorMessage(res, "could not disconnect"));
  }

  const p = state?.provider ?? null;

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Panel
        id="ai-current"
        title="Current provider"
        hint="Summaries, triage suggestions and drafts use this. Each call is counted against the monthly limit."
      >
        <ErrorLine message={error} />
        {state === null ? (
          <p role="status" className="mt-3 text-sm text-ink-subtle">
            Loading…
          </p>
        ) : p === null ? (
          <p className="mt-3 text-sm text-ink-subtle">
            No AI provider yet. AI features stay off until you connect one.
          </p>
        ) : (
          <dl className="mt-3 grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-sm">
            <dt className="text-ink-subtle">Provider</dt>
            <dd>
              {p.label}
              {p.source === "environment" && (
                <span className="ml-2 text-xs text-ink-tertiary">(set by the server)</span>
              )}
            </dd>
            <dt className="text-ink-subtle">Model</dt>
            <dd className="font-mono text-[13px]">{p.model}</dd>
            {p.baseUrl && (
              <>
                <dt className="text-ink-subtle">Endpoint</dt>
                <dd className="break-all font-mono text-[13px]">{p.baseUrl}</dd>
              </>
            )}
            <dt className="text-ink-subtle">Key</dt>
            <dd>{p.hasKey ? "stored, sealed" : "none"}</dd>
            <dt className="text-ink-subtle">This month</dt>
            <dd>
              {dollars(state.usage.spentCents)}
              {p.monthlyCapCents !== null ? ` of ${dollars(p.monthlyCapCents)}` : " (no limit)"} ·{" "}
              {state.usage.calls} {state.usage.calls === 1 ? "call" : "calls"}
            </dd>
          </dl>
        )}

        {p && (
          <div className="mt-5 flex flex-wrap gap-2">
            <button type="button" className={ghostBtn} disabled={pending !== null} onClick={() => void runTest()}>
              {pending === "test" ? "Testing…" : "Test connection"}
            </button>
            {p.editable && (
              <button
                type="button"
                className={dangerBtn}
                disabled={pending !== null}
                onClick={() => setConfirmDisconnect(true)}
              >
                Disconnect
              </button>
            )}
          </div>
        )}
        {test && (
          <div className="mt-4">
            {test.ok ? (
              <Notice tone="healthy" title="The provider answered">
                {test.model} replied in {test.ms} ms.
              </Notice>
            ) : (
              <Notice tone="error" title="The test call failed">
                {test.message ?? "no answer"}
              </Notice>
            )}
          </div>
        )}

        {p?.editable && (
          <form onSubmit={saveCap} className="mt-6 max-w-xs">
            <label className={labelCls} htmlFor="ai-cap">
              Monthly limit in dollars (blank = no limit)
            </label>
            <input
              id="ai-cap"
              name="cap"
              inputMode="decimal"
              defaultValue={p.monthlyCapCents === null ? "" : (p.monthlyCapCents / 100).toFixed(2)}
              key={p.monthlyCapCents ?? "none"}
              className={field}
            />
            <button type="submit" disabled={pending !== null} className={`${ghostBtn} mt-3`}>
              {pending === "cap" ? "Saving…" : "Save limit"}
            </button>
          </form>
        )}
      </Panel>

      <div className="flex flex-col gap-6">
        <Panel
          id="ai-openrouter"
          title="Connect OpenRouter"
          hint="Sign in to OpenRouter and approve. Tallyline gets a key for your account; you never copy or paste it. Starts with a $10 monthly limit."
        >
          <button
            type="button"
            className={`${primaryBtn} mt-4 w-full`}
            disabled={pending !== null}
            onClick={() => void connectOpenRouter()}
          >
            {pending === "connect" ? "Opening OpenRouter…" : p?.kind === "openrouter" && p.editable ? "Reconnect OpenRouter" : "Connect OpenRouter"}
          </button>
        </Panel>

        <Panel
          id="ai-compatible"
          title="Use another endpoint"
          hint="Any server that speaks the OpenAI chat API: OpenAI, Ollama, LM Studio, vLLM or a gateway. The address must be https and public unless the server allows private networks."
        >
          <form onSubmit={saveCompatible}>
            <label className={labelCls} htmlFor="ai-base">
              Base URL
            </label>
            <input
              id="ai-base"
              name="baseUrl"
              type="url"
              required
              placeholder="https://api.openai.com/v1"
              autoComplete="off"
              className={field}
            />
            <label className={labelCls} htmlFor="ai-model">
              Model
            </label>
            <input id="ai-model" name="model" required placeholder="gpt-4o-mini" autoComplete="off" className={field} />
            <label className={labelCls} htmlFor="ai-label">
              Name (optional)
            </label>
            <input id="ai-label" name="label" maxLength={80} placeholder="OpenAI" autoComplete="off" className={field} />
            <label className={labelCls} htmlFor="ai-key">
              API key {p?.kind === "openai_compatible" && p.hasKey ? "(blank keeps the stored key)" : "(optional for local servers)"}
            </label>
            <input id="ai-key" name="apiKey" type="password" autoComplete="off" className={field} />
            <button type="submit" disabled={pending !== null} className={`${ghostBtn} mt-5 w-full`}>
              {pending === "save" ? "Saving…" : "Save endpoint"}
            </button>
          </form>
        </Panel>
      </div>

      {confirmDisconnect && (
        <ConfirmDialog
          title="Disconnect the AI provider?"
          confirmLabel="Disconnect"
          onConfirm={() => void disconnect()}
          onCancel={() => setConfirmDisconnect(false)}
        >
          The stored key is deleted. AI features fall back to the server&apos;s provider, or turn off if there is none.
        </ConfirmDialog>
      )}
    </div>
  );
}
