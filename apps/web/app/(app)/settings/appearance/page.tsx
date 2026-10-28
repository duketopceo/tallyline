import { APPEARANCE_COOKIE, parseAppearance } from "@tallyline/silver-lining";
import { cookies } from "next/headers";
import { AppearanceSettings } from "@/components/appearance-settings";
import { SettingsTabs } from "@/components/settings-tabs";

export default async function AppearancePage() {
  const initial = parseAppearance((await cookies()).get(APPEARANCE_COOKIE)?.value);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-lining-faint px-4">
        <h1 className="text-sm font-semibold">Appearance</h1>
        <SettingsTabs />
      </header>
      <AppearanceSettings initial={initial} />
    </main>
  );
}
