import { api, type Me } from "@/lib/api";
import { ProviderPanel, type ProviderRow } from "@/components/provider-form";
import { SettingsHeader } from "@/components/settings/settings-header";

interface ProvidersResponse { providers?: ProviderRow[] }

export default async function ProvidersPage() {
  const me = await api<Me>("/v1/auth/me");
  if (!me.data) return <main className="p-8 text-sm text-ink-subtle">Not signed in.</main>;
  // providers are instance admin surface (KTD10) — a workspace owner who
  // isn't instance admin gets the locked state, not a 403
  if (!me.data.isInstanceAdmin) {
    return (
      <main className="flex min-h-0 flex-1 flex-col">
        <SettingsHeader title="Sign-in providers" />
        <p className="p-4 text-sm text-ink-subtle">
          Provider administration is locked to instance admins
          (AUTH_ADMIN_EMAILS, or the bootstrap owner on fresh installs).
        </p>
      </main>
    );
  }
  const res = await api<ProvidersResponse>("/v1/auth/providers");
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title="Sign-in providers" />
      <ProviderPanel providers={res.data?.providers ?? []} />
    </main>
  );
}
