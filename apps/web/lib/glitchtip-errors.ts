// Shapes and display rules for a project's GlitchTip error feed. The API
// (apps/api/src/routes/glitchtip-feed.ts) owns the contract; this mirrors it.
export interface ProjectError {
  id: string;
  glitchtipId: string;
  shortId: string | null;
  title: string;
  culprit: string | null;
  level: string;
  status: string;
  count: number;
  userCount: number;
  lastSeen: string | null;
  link: string;
  ticketIssueId: string | null;
}

export interface ErrorHealth {
  connected: boolean;
  mapped: boolean;
  status: string | null;
  link: { orgSlug: string; projectSlug: string; url: string; backoffUntil: string | null } | null;
  openCount: number;
  openCapped: boolean;
  stale: boolean;
  lastSyncedAt: string | null;
  recent: ProjectError[];
}

// Status is always words, never color alone.
const SYNC_STATUS: Record<string, string> = {
  ok: "Up to date",
  rate_limited: "GlitchTip asked us to slow down; showing the last sync",
  unreachable: "GlitchTip did not answer; showing the last sync",
  auth_failed: "GlitchTip rejected the saved token; an admin needs to reconnect",
  not_found: "GlitchTip has no project with that name; check the mapping",
  bad_response: "GlitchTip sent something unexpected; showing the last sync",
  token_unreadable: "The saved token can't be read; an admin needs to reconnect",
};

export function syncStatusText(status: string | null): string {
  if (status === null) return "Not synced yet";
  return SYNC_STATUS[status] ?? "Sync status unknown";
}

export function openLabel(count: number, capped: boolean): string {
  return `${count}${capped ? "+" : ""} open`;
}

const LEVEL_CLASS: Record<string, string> = {
  fatal: "text-urgent",
  error: "text-urgent",
  warning: "text-attention",
};

export function levelClass(level: string): string {
  return LEVEL_CLASS[level] ?? "text-ink-muted";
}

/** Only https (or http on a private-network server) GlitchTip links are rendered as anchors. */
export function safeLink(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}
