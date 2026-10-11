"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AuthCard } from "@/components/account/auth-card";
import { errorMessage, Notice, primaryBtn } from "@/components/account/ui";

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<main className="min-h-screen" />}>
      <VerifyInner />
    </Suspense>
  );
}

// A button, not an automatic POST on load: mail scanners that open links
// must not burn the single-use token before the person does.
function VerifyInner() {
  const token = useSearchParams().get("token") ?? "";
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setPending(true);
    setError(null);
    const res = await fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    setPending(false);
    if (res.ok) setDone(true);
    else setError(await errorMessage(res, "Could not confirm your email. Send a new link from Settings > Account."));
  }

  return (
    <AuthCard title="Confirm your email">
      <div className="mt-5 space-y-4">
        {done ? (
          <>
            <Notice tone="healthy" title="Email confirmed">
              You can now create personal access tokens and agent keys.
            </Notice>
            <Link href="/settings/account" className={`${primaryBtn} w-full`}>
              Go to your account
            </Link>
          </>
        ) : (
          <>
            {error && (
              <Notice tone="error" title={error}>
                <Link href="/settings/account" className="text-accent hover:underline">
                  Open Settings &gt; Account
                </Link>
              </Notice>
            )}
            {!token ? (
              <Notice tone="error" title="This link is missing its token">
                Open the link from the email again.
              </Notice>
            ) : (
              <button type="button" onClick={confirm} disabled={pending} className={`${primaryBtn} w-full`}>
                {pending ? "Confirming…" : "Confirm my email"}
              </button>
            )}
          </>
        )}
      </div>
    </AuthCard>
  );
}
