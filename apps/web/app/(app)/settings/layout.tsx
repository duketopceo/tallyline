import type { ReactNode } from "react";
import { SettingsNav } from "@/components/settings/settings-nav";
import { getMe } from "@/lib/me";
import { visibleSections } from "@/lib/settings-nav";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  const sections = visibleSections({ isInstanceAdmin: me.data?.isInstanceAdmin === true });
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <SettingsNav sections={sections} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
