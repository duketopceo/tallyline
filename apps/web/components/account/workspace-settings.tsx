"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, type FormEvent } from "react";
import { validateSlug } from "@/lib/account-forms";
import {
  dangerBtn,
  errorMessage,
  field,
  labelCls,
  formatDate,
  ghostBtn,
  Notice,
  Panel,
  primaryBtn,
  TypeToConfirm,
} from "@/components/account/ui";

export interface WorkspaceInfo {
  slug: string;
  name: string;
  deletedAt: string | null;
  purgeAfter: string | null;
}

export function WorkspaceSettings({ ws, role }: { ws: WorkspaceInfo; role: string }) {
  const router = useRouter();
  const isOwner = role === "owner";
  const canExport = role === "owner" || role === "admin";
  const canEdit = canExport && !ws.deletedAt;
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [detailsSaved, setDetailsSaved] = useState(false);

  const closeLeave = useCallback(() => {
    setLeaving(false);
    setLeaveError(null);
  }, []);

  async function saveDetails(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get("name") ?? "").trim();
    const slug = isOwner ? String(fd.get("slug") ?? "").trim() : ws.slug;
    setDetailsSaved(false);
    if (name === "") return setDetailsError("Enter a workspace name.");
    const badSlug = validateSlug(slug);
    if (badSlug) return setDetailsError(badSlug);
    setBusy(true);
    setDetailsError(null);
    const res = await fetch("/api/settings/workspace", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ...(slug !== ws.slug ? { slug } : {}) }),
    });
    setBusy(false);
    if (res.ok) {
      setDetailsSaved(true);
      router.refresh();
    } else {
      setDetailsError(await errorMessage(res, "Could not save the workspace. Try again."));
    }
  }

  async function leaveWorkspace(typed: string) {
    setBusy(true);
    setLeaveError(null);
    const res = await fetch("/api/settings/workspace/leave", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    });
    if (res.ok) {
      window.location.assign("/settings/workspace");
      return;
    }
    setBusy(false);
    setLeaveError(await errorMessage(res, "Could not leave the workspace. Try again."));
  }
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const closeDelete = useCallback(() => {
    setDeleting(false);
    setError(null);
  }, []);

  async function scheduleDeletion(typed: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/settings/workspace/deletion", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: typed }),
    });
    setBusy(false);
    if (res.ok) {
      setDeleting(false);
      setRestored(false);
      router.refresh();
    } else {
      setError(await errorMessage(res, "Could not delete the workspace. Try again."));
    }
  }

  async function restore() {
    setBusy(true);
    setRestoreError(null);
    const res = await fetch("/api/settings/workspace/restore", { method: "POST" });
    setBusy(false);
    if (res.ok) {
      setRestored(true);
      router.refresh();
    } else {
      setRestoreError(await errorMessage(res, "Could not restore the workspace. Try again."));
    }
  }

  const exportLink = (
    <a href="/api/settings/workspace/export" download className={ghostBtn}>
      Download workspace export
    </a>
  );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      {ws.deletedAt && ws.purgeAfter && (
        <Notice tone="attention" title={`${ws.name} is scheduled for deletion`}>
          <p>
            It is closed for everyone and will be permanently deleted on{" "}
            <time dateTime={ws.purgeAfter}>{formatDate(ws.purgeAfter)}</time>.
            {isOwner ? " Restore it to bring everything back as it was." : " Ask an owner to restore it."}
          </p>
          {isOwner && (
            <button type="button" onClick={restore} disabled={busy} className={`${primaryBtn} mt-3`}>
              {busy ? "Restoring…" : "Restore workspace"}
            </button>
          )}
          {restoreError && <p className="mt-2 text-urgent">{restoreError}</p>}
        </Notice>
      )}
      {restored && !ws.deletedAt && <Notice tone="healthy" title={`${ws.name} is restored`} />}

      <Panel title="Workspace">
        <dl className="mt-3 grid grid-cols-[96px_1fr] gap-y-2 text-[13px]">
          <dt className="text-ink-subtle">Name</dt>
          <dd className="text-ink">{ws.name}</dd>
          <dt className="text-ink-subtle">Slug</dt>
          <dd className="font-mono text-ink">{ws.slug}</dd>
          <dt className="text-ink-subtle">Your role</dt>
          <dd className="text-ink">{role}</dd>
        </dl>
      </Panel>

      {canEdit && (
        <Panel
          title="Edit workspace"
          hint={
            isOwner
              ? "Changing the slug changes every link to this workspace. Old links stop working."
              : "Admins can rename the workspace. Only an owner can change the slug."
          }
        >
          <form onSubmit={saveDetails} className="mt-1" noValidate>
            <label htmlFor="ws-name" className={labelCls}>
              Name
            </label>
            <input id="ws-name" name="name" defaultValue={ws.name} maxLength={120} className={field} />
            <label htmlFor="ws-slug" className={labelCls}>
              Slug
            </label>
            <input
              id="ws-slug"
              name="slug"
              defaultValue={ws.slug}
              maxLength={48}
              readOnly={!isOwner}
              aria-describedby={isOwner ? undefined : "ws-slug-note"}
              autoComplete="off"
              spellCheck={false}
              className={`${field} font-mono`}
            />
            {!isOwner && (
              <p id="ws-slug-note" className="mt-1 text-xs text-ink-subtle">
                Only an owner can change the slug.
              </p>
            )}
            {detailsError && (
              <p role="alert" className="mt-3 text-body text-urgent">
                {detailsError}
              </p>
            )}
            {detailsSaved && !detailsError && (
              <div className="mt-3">
                <Notice tone="healthy" title="Workspace saved" />
              </div>
            )}
            <button type="submit" disabled={busy} className={`${primaryBtn} mt-4`}>
              {busy ? "Saving…" : "Save workspace"}
            </button>
          </form>
        </Panel>
      )}

      <Panel
        title="Export"
        hint="One JSON file with every issue, comment, project, cycle, view, agent, webhook and activity entry in this workspace, plus an attachments manifest. Secrets and token hashes are left out."
      >
        <div className="mt-4">
          {canExport ? exportLink : <p className="text-[13px] text-ink-subtle">Admins and owners can export.</p>}
        </div>
      </Panel>

      <Panel
        title="Leave workspace"
        tone="danger"
        hint={
          isOwner
            ? "You can leave once another person is an owner. You lose access to its issues and your personal access tokens for it stop working."
            : "You lose access to its issues, and your personal access tokens for it stop working. An owner or admin can invite you back."
        }
      >
        <button type="button" onClick={() => setLeaving(true)} className={`${dangerBtn} mt-4`}>
          Leave workspace
        </button>
      </Panel>

      {!ws.deletedAt && (
        <Panel
          title="Danger zone"
          tone="danger"
          hint={
            isOwner
              ? "Deleting closes the workspace for everyone right away. You can restore it for 7 days; after that it is permanently deleted with everything in it."
              : "Only an owner can delete this workspace."
          }
        >
          {isOwner && (
            <button type="button" onClick={() => setDeleting(true)} className={`${dangerBtn} mt-4`}>
              Delete workspace
            </button>
          )}
        </Panel>
      )}

      {leaving && (
        <TypeToConfirm
          title={`Leave ${ws.name}`}
          expected={ws.slug}
          inputLabel={`Type ${ws.slug} to confirm`}
          confirmLabel={`Leave ${ws.slug}`}
          busy={busy}
          error={leaveError}
          onConfirm={leaveWorkspace}
          onCancel={closeLeave}
        >
          <p>You lose access right away. Your issues and comments stay with the workspace.</p>
          <p>If this is your only workspace, or you are its only owner, you cannot leave yet.</p>
        </TypeToConfirm>
      )}

      {deleting && (
        <TypeToConfirm
          title={`Delete ${ws.name}`}
          expected={ws.slug}
          inputLabel={`Type ${ws.slug} to confirm`}
          confirmLabel={`Delete ${ws.slug}`}
          busy={busy}
          error={error}
          onConfirm={scheduleDeletion}
          onCancel={closeDelete}
        >
          <p>Everyone loses access right away. Agents and webhooks stop.</p>
          <p>You can restore it for 7 days. After that, it is permanently deleted and cannot be recovered.</p>
          <p>
            Want a copy first?{" "}
            <a href="/api/settings/workspace/export" download className="text-accent underline underline-offset-2">
              Download workspace export
            </a>
          </p>
        </TypeToConfirm>
      )}
    </div>
  );
}
