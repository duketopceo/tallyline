"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { errorMessage, field, labelCls, Notice, Panel, primaryBtn } from "@/components/account/ui";
import { PASSWORD_MIN, validatePasswordChange, validateProfile } from "@/lib/account-forms";

// Settings > Account: edit name and picture. The email is shown by the
// account panel and changes through support, so it is not editable here.
export function ProfileForm({ name, avatarUrl }: { name: string; avatarUrl: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const checked = validateProfile(String(fd.get("name") ?? ""), String(fd.get("avatarUrl") ?? ""));
    setSaved(false);
    if (!checked.ok) {
      setError(checked.error);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/account/profile", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checked.body),
    });
    setBusy(false);
    if (res.ok) {
      setSaved(true);
      router.refresh();
    } else {
      setError(await errorMessage(res, "Could not save your profile. Try again."));
    }
  }

  return (
    <Panel title="Edit profile" hint="Your name and picture show on issues, comments and the members list.">
      <form onSubmit={submit} className="mt-1" noValidate>
        <label htmlFor="profile-name" className={labelCls}>
          Name
        </label>
        <input id="profile-name" name="name" defaultValue={name} maxLength={120} autoComplete="name" className={field} />
        <label htmlFor="profile-avatar" className={labelCls}>
          Picture address (optional)
        </label>
        <input
          id="profile-avatar"
          name="avatarUrl"
          type="url"
          inputMode="url"
          defaultValue={avatarUrl ?? ""}
          placeholder="https://"
          autoComplete="off"
          aria-describedby="profile-avatar-hint"
          className={field}
        />
        <p id="profile-avatar-hint" className="mt-1 text-xs text-ink-subtle">
          A link to an image, starting with https://. Leave it empty to show your initials.
        </p>
        {error && (
          <p role="alert" className="mt-3 text-body text-urgent">
            {error}
          </p>
        )}
        {saved && !error && (
          <div className="mt-3">
            <Notice tone="healthy" title="Profile saved" />
          </div>
        )}
        <button type="submit" disabled={busy} className={`${primaryBtn} mt-4`}>
          {busy ? "Saving…" : "Save profile"}
        </button>
      </form>
    </Panel>
  );
}

// Settings > Account: change password while signed in. Shown only to people
// who have one; others get the way to set one.
export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!hasPassword) {
    return (
      <Panel title="Password">
        <p className="mt-2 text-body text-ink-muted">
          You sign in without a password. To add one,{" "}
          <Link href="/forgot-password" className="text-accent underline underline-offset-2">
            request a password link
          </Link>
          .
        </p>
      </Panel>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const current = String(fd.get("current") ?? "");
    const next = String(fd.get("next") ?? "");
    setDone(false);
    const invalid = validatePasswordChange(current, next, String(fd.get("confirm") ?? ""));
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch("/api/account/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setBusy(false);
    if (res.ok) {
      form.reset();
      setDone(true);
    } else {
      setError(await errorMessage(res, "Could not change your password. Try again."));
    }
  }

  return (
    <Panel
      title="Change password"
      hint={`At least ${PASSWORD_MIN} characters. Your other signed-in browsers and devices are signed out; personal access tokens keep working.`}
    >
      <form onSubmit={submit} className="mt-1" noValidate>
        <label htmlFor="pw-current" className={labelCls}>
          Current password
        </label>
        <input id="pw-current" name="current" type="password" autoComplete="current-password" className={field} />
        <label htmlFor="pw-next" className={labelCls}>
          New password
        </label>
        <input id="pw-next" name="next" type="password" autoComplete="new-password" className={field} />
        <label htmlFor="pw-confirm" className={labelCls}>
          Confirm new password
        </label>
        <input id="pw-confirm" name="confirm" type="password" autoComplete="new-password" className={field} />
        {error && (
          <p role="alert" className="mt-3 text-body text-urgent">
            {error}
          </p>
        )}
        {done && !error && (
          <div className="mt-3">
            <Notice tone="healthy" title="Password changed" />
          </div>
        )}
        <button type="submit" disabled={busy} className={`${primaryBtn} mt-4`}>
          {busy ? "Changing…" : "Change password"}
        </button>
      </form>
    </Panel>
  );
}
