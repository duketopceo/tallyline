import { api, type Me } from "@/lib/api";
import { approvableWorkspaces, parseUserCode } from "@/lib/device-code";
import { DeviceForm } from "./device-form";

// Approve a sign-in started by the Tallyline CLI (`tallyline connect`), RFC 8628.
// Middleware sends signed-out people through /login and back here with the
// code intact. The page only shows the request and posts the decision; the
// API enforces session, verified email and admin role.
export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  const me = await api<Me>("/v1/auth/me");
  const workspaces = approvableWorkspaces(me.data?.memberships);
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-md rounded-md border border-lining bg-surface-1 p-6">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">tallyline</p>
        <DeviceForm
          initialCode={parseUserCode(code) ?? ""}
          workspaces={workspaces}
          emailVerified={me.data?.emailVerified !== false}
        />
      </div>
    </main>
  );
}
