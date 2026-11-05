// The one list of settings pages. The sidebar, the /settings overview and the
// mobile back link all read it, so web settings keep the same groups as the
// iOS Settings sheet (profile first, grouped rows, destructive last).

export interface SettingsItem {
  href: string;
  label: string;
  description: string;
  /** shown only to instance admins (the dev mail inbox) */
  instanceAdminOnly?: boolean;
}

export interface SettingsSection {
  id: string;
  label: string;
  items: SettingsItem[];
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    id: "account",
    label: "Account",
    items: [
      { href: "/settings/account", label: "Account", description: "Profile, email, your data and account deletion" },
      { href: "/settings/appearance", label: "Appearance", description: "Theme, contrast and density" },
      { href: "/settings/devices", label: "Devices", description: "Pair the iPhone app with this account" },
      { href: "/settings/tokens", label: "Tokens", description: "Personal access tokens for scripts and the CLI" },
      { href: "/settings/dev-inbox", label: "Dev inbox", description: "Mail captured by the log transport", instanceAdminOnly: true },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { href: "/settings/workspace", label: "Workspace", description: "Name, export and workspace deletion" },
      { href: "/settings/members", label: "Members", description: "Who is in this workspace and their roles" },
      { href: "/settings/invites", label: "Invites", description: "Invite people and manage open invites" },
      { href: "/settings/usage", label: "Usage", description: "Plan, limits and activity this month" },
      { href: "/welcome", label: "Setup", description: "The setup checklist for this server" },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    items: [
      { href: "/settings/labels", label: "Labels", description: "Labels for sorting and filtering issues" },
      { href: "/settings/projects", label: "Projects", description: "Projects, leads and target dates" },
      { href: "/settings/cycles", label: "Cycles", description: "Cycle cadence for each team" },
    ],
  },
  {
    id: "agents",
    label: "Agents and AI",
    items: [
      { href: "/settings/agents", label: "Agents", description: "Agent identities, keys and connecting a coding agent" },
      { href: "/settings/ai", label: "AI", description: "The model provider for summaries and suggestions" },
    ],
  },
  {
    id: "integrations",
    label: "Integrations and access",
    items: [
      { href: "/settings/integrations", label: "Integrations", description: "GitHub repositories and error intake" },
      { href: "/settings/providers", label: "Providers", description: "Sign-in methods for this server" },
    ],
  },
];

export function visibleSections({ isInstanceAdmin }: { isInstanceAdmin: boolean }): SettingsSection[] {
  return SETTINGS_SECTIONS.map((s) => ({
    ...s,
    items: s.items.filter((i) => !i.instanceAdminOnly || isInstanceAdmin),
  })).filter((s) => s.items.length > 0);
}

const ALL_ITEMS = SETTINGS_SECTIONS.flatMap((s) => s.items);

/** The item a path belongs to: itself, or the parent of a nested page. */
export function activeHref(pathname: string): string | null {
  const hit = ALL_ITEMS.find((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  return hit?.href ?? null;
}

/** Where the phone-width back link goes: the parent page, else the overview. */
export function backTarget(pathname: string): { href: string; label: string } {
  const parent = activeHref(pathname);
  if (parent && parent !== pathname) {
    return { href: parent, label: ALL_ITEMS.find((i) => i.href === parent)!.label };
  }
  return { href: "/settings", label: "Settings" };
}
