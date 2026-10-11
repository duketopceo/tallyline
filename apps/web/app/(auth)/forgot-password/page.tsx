"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/account/auth-card";
import { errorMessage, field, labelCls, Notice, primaryBtn } from "@/components/account/ui";

export default function ForgotPasswordPage() {
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const res = await fetch("/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    setPending(false);
    if (res.status === 202) setSent(email);
    else setError(await errorMessage(res, "Could not send the reset link. Try again in a minute."));
  }

  return (
    <AuthCard title="Reset your password">
      {sent ? (
        <div className="mt-5">
          <Notice tone="healthy" title="Check your email">
            If an account uses {sent}, a reset link is on its way. It works once and expires in 30 minutes.
          </Notice>
          <Link href="/login" className="mt-5 inline-block text-[13px] text-accent hover:underline">
            Back to sign in
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit}>
          <p className="mt-2 text-[13px] text-ink-muted">
            Enter the email you sign in with. We will send a link to set a new password.
          </p>
          {error && (
            <div className="mt-4">
              <Notice tone="error" title={error} />
            </div>
          )}
          <label htmlFor="email" className={labelCls}>
            Email
          </label>
          <input id="email" name="email" type="email" required autoFocus autoComplete="email" className={field} />
          <button type="submit" disabled={pending} className={`${primaryBtn} mt-6 w-full`}>
            {pending ? "Sending…" : "Send reset link"}
          </button>
          <Link href="/login" className="mt-4 inline-block text-[13px] text-accent hover:underline">
            Back to sign in
          </Link>
        </form>
      )}
    </AuthCard>
  );
}
