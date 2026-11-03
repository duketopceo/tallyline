import { api, type Me } from "@/lib/api";
import { PairingPanel } from "@/components/settings/pairing-panel";
import { PageHeader } from "@/components/settings/ui";

export default async function DevicesPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title="Devices" meta={me.data.workspaceSlug} />
      <PairingPanel />
    </main>
  );
}
