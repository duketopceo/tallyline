"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { DEFAULT_LANDING } from "@/lib/landing";

// invite landing — authed users accept in place; unauthed users either log
// in (return_to round-trips this page) or claim with {name, password} on
// password-enabled installs; OAuth-configured installs round-trip through
// provider start with the invite carried in state
export default function JoinPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [state, setState] = useState<
    | "loading"
    | "authed"
    | "claim"
    | "oauth"
    | "done"
    | "gone"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [providers, setProviders] = useState<{ key: string; label: string; startUrl: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const me = await fetch("/api/me");
      if (cancelled) return;
      if (me.ok) {
        setState("authed");
        return;
      }
      const methods = await fetch("/api/auth/methods").then((r) =>
        r.ok ? r.json() : null,
      );
      if (cancelled) return;
      setProviders(methods?.providers ?? []);
      setState(methods?.password === false ? "oauth" : "claim");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function accept() {
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (res.ok) {
      setState("done");
      router.replace(DEFAULT_LANDING);
      router.refresh();
    } else if (res.status === 410) {
      setState("gone");
    } else {
      const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(d?.error?.message ?? "could not accept this invite");
    }
  }

  async function claim(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/accept-invite", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        name: fd.get("name"),
        password: fd.get("password"),
      }),
    });
    setPending(false);
    if (res.ok) {
      router.replace(DEFAULT_LANDING);
      router.refresh();
    } else if (res.status === 410) {
      setState("gone");
    } else {
      const d = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(d?.error?.message ?? "could not claim this invite");
    }
  }

  const field =
    "mt-1 w-full rounded-sm border border-lining bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-lining-strong";
  const label = "mt-4 block text-xs text-ink-subtle";

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-md border border-lining bg-surface-1 p-6">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">
          tallyline
        </p>
        <h1 className="mt-2 text-lg font-semibold">Join the workspace</h1>

        {error && (
          <p role="alert" className="mt-4 rounded-sm border border-lining-bright px-3 py-2 text-sm text-ink-muted">
            {error}
          </p>
        )}

        {state === "loading" && (
          <p className="mt-4 text-sm text-ink-subtle">checking your invite…</p>
        )}
        {state === "gone" && (
          <p className="mt-4 text-sm text-ink-muted">
            This invite has expired or already been used — ask an admin for a
            new link.
          </p>
        )}
        {state === "authed" && (
          <>
            <p className="mt-2 text-sm text-ink-subtle">
              You're signed in — accept the invite to join.
            </p>
            <button
              onClick={accept}
              disabled={pending}
              className="mt-5 w-full rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
            >
              {pending ? "Joining…" : "Accept invite"}
            </button>
          </>
        )}
        {state === "claim" && (
          <>
            <p className="mt-2 text-sm text-ink-subtle">
              Create your account to accept the invite. Already have one?{" "}
              <Link
                className="text-accent underline underline-offset-2"
                href={`/login?return_to=${encodeURIComponent(`/join/${token}`)}`}
              >
                Sign in
              </Link>
            </p>
            {providers.map((p) => (
              <a
                key={p.key}
                href={`${p.startUrl}&invite=${encodeURIComponent(token)}`}
                className="mt-3 block w-full rounded-sm border border-lining bg-surface-2 px-3 py-2 text-center text-sm text-ink hover:border-lining-strong"
              >
                Continue with {p.label}
              </a>
            ))}
            <form onSubmit={claim} className="mt-2">
              <label className={label} htmlFor="name">
                Name
              </label>
              <input id="name" name="name" required autoFocus className={field} />
              <label className={label} htmlFor="password">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                minLength={10}
                className={field}
              />
              <button
                type="submit"
                disabled={pending}
                className="mt-5 w-full rounded-sm bg-accent px-3 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-60"
              >
                {pending ? "Joining…" : "Create account & join"}
              </button>
            </form>
          </>
        )}
        {state === "oauth" && (
          <>
            <p className="mt-2 text-sm text-ink-subtle">
              Accept the invite with your sign-in provider.
            </p>
            {providers.map((p) => (
              <a
                key={p.key}
                href={`${p.startUrl}&invite=${encodeURIComponent(token)}`}
                className="mt-3 block w-full rounded-sm border border-lining bg-surface-2 px-3 py-2 text-center text-sm text-ink hover:border-lining-strong"
              >
                Continue with {p.label}
              </a>
            ))}
            <p className="mt-4 text-xs text-ink-subtle">
              Already have an account?{" "}
              <Link
                className="text-accent underline underline-offset-2"
                href={`/login?return_to=${encodeURIComponent(`/join/${token}`)}`}
              >
                Sign in
              </Link>
            </p>
          </>
        )}
      </div>
    </main>
  );
}
