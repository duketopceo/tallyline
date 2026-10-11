import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/app/providers";
import { PeekPanel } from "@/components/app/peek-panel";
import { Shell } from "@/components/app/shell";
import { CommandPalette } from "@/components/command-palette";
import { GlobalActions } from "@/components/app/global-actions";
import { GlobalNav } from "@/components/global-nav";
import { KeymapOverlay } from "@/components/keymap-overlay";
import { QuickCreate } from "@/components/quick-create";
import { AccountGate } from "@/components/account/account-gate";
import { api, type Me } from "@/lib/api";
import { loadMeta } from "@/lib/meta";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) redirect("/login");
  // removed-member bounce (R15): zero memberships → out; the session's
  // active workspace gone but others remain → through the chooser
  const memberships = me.data.memberships ?? [];
  if (memberships.length === 0) redirect("/login?error=no_workspace");
  if (!memberships.some((m) => m.workspaceSlug === me.data!.workspaceSlug)) {
    redirect("/workspaces");
  }
  const active = memberships.find((m) => m.workspaceSlug === me.data!.workspaceSlug);
  const meta = await loadMeta(me.data.workspaceSlug, { userId: me.data.userId, name: me.data.name, role: active?.role });
  const pendingDeletion =
    active?.deletedAt && active.purgeAfter
      ? { name: active.workspaceName ?? active.workspaceSlug, purgeAfter: active.purgeAfter }
      : null;
  return (
    <AppProviders meta={meta}>
      <Shell peek={<PeekPanel />}>
        <AccountGate
          emailVerified={me.data.emailVerified !== false}
          pendingDeletion={pendingDeletion}
        >
          {children}
        </AccountGate>
      </Shell>
      <QuickCreate />
      <CommandPalette workspace={me.data.workspaceSlug} />
      <GlobalNav />
      <GlobalActions />
      <KeymapOverlay />
    </AppProviders>
  );
}
