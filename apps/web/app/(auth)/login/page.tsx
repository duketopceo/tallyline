"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { TallyMark } from "@/components/tally-mark";

interface Provider {
  key: string;
  type: string;
  label: string;
  startUrl: string;
}

const ERROR_COPY: Record<string, string> = {
  state: "sign-in session expired — try again",
  denied: "sign-in was cancelled at the provider",
  exchange: "sign-in code expired — try again",
  invite_required: "this workspace requires an invite",
  link_disabled: "account linking is disabled on this instance",
  no_workspace: "your account has no workspace — ask an admin for an invite",
  plan_limit: "this workspace has no free member seats on its plan — ask an admin to free a seat or move to the Team plan",
  auth: "sign-in failed — try again",
};

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [methods, setMethods] = useState<{
    password: boolean;
    providers: Provider[];
    unavailable: boolean;
  } | null>(null);

  const returnTo = params.get("return_to") ?? params.get("next") ?? "/my-issues";

  useEffect(() => {
    const code = params.get("error");
    if (code) setError(ERROR_COPY[code] ?? ERROR_COPY.auth!);
    fetch("/api/auth/methods")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // on failure render the password form optimistically — the wrong
        // default is a login card with no way in
        if (!d) {
          setMethods({ password: true, providers: [], unavailable: true });
        } else {
          setMethods({ password: d.password !== false, providers: d.providers ?? [], unavailable: false });
        }
      })
      .catch(() => setMethods({ password: true, providers: [], unavailable: true }));
  }, [params]);

  function providerUrl(p: Provider) {
    const u = new URL(p.startUrl);
    if (returnTo) u.searchParams.set("return_to", returnTo);
    return u.toString();
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: fd.get("email"),
        password: fd.get("password"),
        return_to: returnTo,
      }),
    });
    setPending(false);
    if (res.ok) {
      const d = (await res.json()) as { returnTo?: string };
      router.replace(d.returnTo ?? "/my-issues");
      router.refresh();
    } else {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "sign-in failed — check credentials");
    }
  }

  const input = "mt-1 block h-10 w-full rounded-sm border border-control bg-surface-2 px-3 text-[14px] text-ink placeholder:text-ink-subtle";
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(420px,520px)_1fr]">
      <main className="flex flex-col justify-center px-6 py-10 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="flex items-center gap-2" aria-label="Tallyline home">
            <TallyMark size={28} />
            <span className="text-[17px] font-semibold tracking-tight">tallyline</span>
          </Link>
          <h1 className="mt-8 text-[24px] font-semibold leading-tight tracking-[-0.4px]">Sign in</h1>
          <p className="mt-1 text-[13px] text-ink-muted">One board for you and your agents.</p>

          {error && (
            <p role="alert" className="mt-5 rounded-sm border border-lining-bright bg-surface-2 px-3 py-2 text-[13px] text-ink">
              <span className="font-medium text-urgent">Could not sign in.</span> {error}
            </p>
          )}

          {(!methods || methods.password) && (
            <form onSubmit={onSubmit} className="mt-6">
              <label className="block text-[13px] text-ink-muted" htmlFor="email">Email
                <input id="email" name="email" type="email" required autoFocus autoComplete="email" className={input} />
              </label>
              <label className="mt-4 block text-[13px] text-ink-muted" htmlFor="password">Password
                <input id="password" name="password" type="password" required autoComplete="current-password" className={input} />
              </label>
              <Link href="/forgot-password" className="mt-2 inline-block text-[13px] text-accent hover:underline">
                Forgot your password?
              </Link>
              <button type="submit" disabled={pending} className="mt-6 h-10 w-full rounded-sm bg-accent px-3 text-[14px] font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60">
                {pending ? "Signing in" : "Sign in"}
              </button>
            </form>
          )}

          {methods && methods.providers.length > 0 && (
            <div className="mt-6 border-t border-lining pt-5">
              <p className="text-[12px] text-ink-subtle">Or continue with</p>
              <div className="mt-3 space-y-2">
                {methods.providers.map((p) => (
                  <a key={p.key} href={providerUrl(p)} className="flex h-10 w-full items-center justify-center rounded-sm border border-control bg-surface-1 text-[14px] text-ink hover:bg-surface-2">
                    {p.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          {methods?.unavailable && <p className="mt-4 text-[12px] text-ink-subtle">Sign-in providers are unavailable. Use email and password.</p>}

          <p className="mt-8 text-[12px] leading-relaxed text-ink-subtle">
            Invited? Open the invite link you were sent. Running a new instance? <Link href="/bootstrap" className="text-accent underline underline-offset-2 hover:text-accent-hover">Create the first workspace</Link>.
          </p>
          <p className="mt-2 text-[12px] text-ink-subtle">Hosted beta: no SLA, and data may be lost.</p>
        </div>
      </main>
      <aside aria-hidden className="relative hidden overflow-hidden border-l border-lining-faint bg-surface-1 lg:block">
        <div className="absolute left-12 right-0 top-1/2 -translate-y-1/2">
          <p className="max-w-md pr-12 text-[17px] font-semibold leading-snug tracking-[-0.2px]">Agents are teammates here: identities, sessions and a review queue.</p>
          <div className="mt-6 overflow-hidden rounded-l-lg border border-r-0 border-lining-strong">
            <picture>
              <source media="(prefers-color-scheme: light)" srcSet="/landing/board-light.webp" />
              <img src="/landing/board-dark.webp" alt="" width={1280} height={800} decoding="async" className="block h-auto w-full" />
            </picture>
          </div>
        </div>
      </aside>
    </div>
  );
}
