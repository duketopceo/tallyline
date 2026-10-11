"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import {
  dangerBtn,
  errorMessage,
  ghostBtn,
  Notice,
  Panel,
  TypeToConfirm,
} from "@/components/account/ui";

export function AccountSettings({
  name,
  email,
  emailVerified,
  isInstanceAdmin,
  ownedWorkspaces,
}: {
  name: string;
  email: string;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
  ownedWorkspaces: string[];
}) {
  const [resend, setResend] = useState<"idle" | "sending" | "sent" | "recent" | "error">("idle");
  const [resendError, setResendError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function sendLink() {
    setResend("sending");
    const res = await fetch("/api/account/verify-email", { method: "POST" });
    if (res.ok) {
      const d = (await res.json().catch(() => null)) as { status?: string } | null;
      setResend(d?.status === "recently_sent" ? "recent" : "sent");
    } else {
      setResendError(await errorMessage(res, "Could not send the link. Try again in a minute."));
      setResend("error");
    }
  }

  const closeDelete = useCallback(() => {
    setDeleting(false);
    setDeleteError(null);
  }, []);

  async function deleteAccount(typed: string) {
    setBusy(true);
    setDeleteError(null);
    const res = await fetch("/api/account/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    });
    if (res.ok) {
      window.location.assign("/login?error=account_deleted");
      return;
    }
    setBusy(false);
    setDeleteError(await errorMessage(res, "Could not delete your account. Try again."));
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <Panel title="Profile">
        <dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-2 text-[13px]">
          <dt className="text-ink-subtle">Name</dt>
          <dd className="text-ink">{name}</dd>
          <dt className="text-ink-subtle">Email</dt>
          <dd className="flex flex-wrap items-center gap-2 text-ink">
            <span className="break-all">{email}</span>
            {emailVerified ? (
              <span className="inline-flex items-center gap-1 rounded-sm bg-healthy-soft px-1.5 text-[11px] text-ink">
                <span aria-hidden="true">✓</span> Confirmed
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-sm bg-attention-soft px-1.5 text-[11px] text-ink">
                <span aria-hidden="true">!</span> Not confirmed
              </span>
            )}
          </dd>
        </dl>
        {!emailVerified && (
          <div className="mt-4 space-y-3">
            <p className="text-[13px] text-ink-muted">
              Confirm your email to create personal access tokens and agent keys. The link we sent works for 24
              hours.
            </p>
            {resend === "sent" ? (
              <Notice tone="healthy" title={`New link sent to ${email}`} />
            ) : resend === "recent" ? (
              <Notice tone="attention" title={`A link went to ${email} less than a minute ago`}>
                Check your inbox and spam folder. You can ask for another one in a minute.
              </Notice>
            ) : (
              <button type="button" onClick={sendLink} disabled={resend === "sending"} className={ghostBtn}>
                {resend === "sending" ? "Sending…" : "Send a new link"}
              </button>
            )}
            {resend === "error" && resendError && <Notice tone="error" title={resendError} />}
          </div>
        )}
      </Panel>

      <Panel
        title="Your data"
        hint="One JSON file with your profile, memberships, tokens (names only), views, the issues and comments you wrote, and your security log."
      >
        <a href="/api/account/export" download className={`${ghostBtn} mt-4`}>
          Download my data
        </a>
      </Panel>

      {isInstanceAdmin && (
        <Panel title="Dev inbox" hint="With the log mail transport, outgoing mail is captured here instead of sent.">
          <Link href="/settings/dev-inbox" className={`${ghostBtn} mt-4`}>
            Open dev inbox
          </Link>
        </Panel>
      )}

      <Panel
        title="Delete account"
        tone="danger"
        hint={
          <>
            Deletes you, your sessions, personal access tokens and saved views right away. This cannot be undone.
            Issues and comments you wrote stay with their workspace without your name.
            {ownedWorkspaces.length > 0 && (
              <> If you are the only owner of {ownedWorkspaces.join(", ")}, make someone else an owner or delete the workspace first.</>
            )}
          </>
        }
      >
        <button type="button" onClick={() => setDeleting(true)} className={`${dangerBtn} mt-4`}>
          Delete my account
        </button>
      </Panel>

      {deleting && (
        <TypeToConfirm
          title="Delete your account"
          expected={email}
          inputLabel={`Type ${email} to confirm`}
          confirmLabel="Delete my account"
          busy={busy}
          error={deleteError}
          onConfirm={deleteAccount}
          onCancel={closeDelete}
        >
          <p>This deletes your account immediately and cannot be undone.</p>
          <p>
            Want a copy first?{" "}
            <a href="/api/account/export" download className="text-accent hover:underline">
              Download my data
            </a>
          </p>
        </TypeToConfirm>
      )}
    </div>
  );
}
