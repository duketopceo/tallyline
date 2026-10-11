"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  dangerBtn,
  errorMessage,
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

      <Panel
        title="Export"
        hint="One JSON file with every issue, comment, project, cycle, view, agent, webhook and activity entry in this workspace, plus an attachments manifest. Secrets and token hashes are left out."
      >
        <div className="mt-4">
          {canExport ? exportLink : <p className="text-[13px] text-ink-subtle">Admins and owners can export.</p>}
        </div>
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
            <a href="/api/settings/workspace/export" download className="text-accent hover:underline">
              Download workspace export
            </a>
          </p>
        </TypeToConfirm>
      )}
    </div>
  );
}
