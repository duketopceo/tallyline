"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/account/auth-card";
import { errorMessage, field, labelCls, Notice, primaryBtn } from "@/components/account/ui";

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <ResetInner />
    </Suspense>
  );
}

function ResetInner() {
  const token = useSearchParams().get("token") ?? "";
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get("password") ?? "");
    if (password !== String(fd.get("confirm") ?? "")) {
      setError("The two passwords do not match. Type the same password in both fields.");
      return;
    }
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setPending(false);
    if (res.ok) setDone(true);
    else setError(await errorMessage(res, "Could not set the password. Request a new link."));
  }

  if (!token) {
    return (
      <AuthCard title="Set a new password">
        <div className="mt-5">
          <Notice tone="error" title="This link is missing its token">
            Open the link from the email again, or{" "}
            <Link href="/forgot-password" className="text-accent hover:underline">
              request a new one
            </Link>
            .
          </Notice>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set a new password">
      {done ? (
        <div className="mt-5">
          <Notice tone="healthy" title="Password changed">
            You were signed out everywhere. Sign in with your new password.
          </Notice>
          <Link href="/login" className={`${primaryBtn} mt-5 w-full`}>
            Sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <p className="mt-2 text-[13px] text-ink-muted">
            At least 10 characters. Setting it signs you out on every device; your personal access tokens keep working.
          </p>
          {error && (
            <div className="mt-4">
              <Notice tone="error" title={error}>
                {/expired|used/.test(error) && (
                  <Link href="/forgot-password" className="text-accent hover:underline">
                    Request a new link
                  </Link>
                )}
              </Notice>
            </div>
          )}
          <label htmlFor="password" className={labelCls}>
            New password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            required
            minLength={10}
            autoFocus
            autoComplete="new-password"
            className={field}
          />
          <label htmlFor="confirm" className={labelCls}>
            Type it again
          </label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            className={field}
          />
          <button type="submit" disabled={pending} className={`${primaryBtn} mt-6 w-full`}>
            {pending ? "Saving…" : "Set new password"}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
