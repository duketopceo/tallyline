import { APPEARANCE_COOKIE, parseAppearance } from "@tallyline/silver-lining";
import { cookies } from "next/headers";
import { AppearanceSettings } from "@/components/appearance-settings";
import { SettingsHeader } from "@/components/settings/settings-header";

export default async function AppearancePage() {
  const initial = parseAppearance((await cookies()).get(APPEARANCE_COOKIE)?.value);
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <SettingsHeader title="Appearance" />
      <AppearanceSettings initial={initial} />
    </main>
  );
}
