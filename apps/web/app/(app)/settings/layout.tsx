import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { api, type Me } from "@/lib/api";
import { visibleSections } from "@/lib/settings-nav";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await api<Me>("/v1/auth/me");
  const sections = visibleSections({ isInstanceAdmin: me.data?.isInstanceAdmin === true });
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SettingsNav sections={sections} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
