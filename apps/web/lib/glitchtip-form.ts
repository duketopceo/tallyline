// Pure helpers for the GlitchTip integration card: project-map rows to the
// PUT body and back. Kept free of React so they run in the node test env.

export interface MapRow {
  name: string;
  team: string;
}

export interface ConfigBody {
  projectMap: Record<string, string>;
  defaultTeamKey: string | null;
}

export type BuildResult =
  | { ok: true; body: ConfigBody }
  | { ok: false; error: string };

export function rowsFromMap(map: Record<string, string> | undefined): MapRow[] {
  return Object.entries(map ?? {})
    .map(([name, team]) => ({ name, team }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function buildConfigBody(
  rows: MapRow[],
  defaultTeamKey: string,
): BuildResult {
  const projectMap: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim().toLowerCase();
    const team = row.team.trim().toUpperCase();
    if (!name && !team) continue;
    if (!name) return { ok: false, error: "a mapped row needs a GlitchTip project name" };
    if (!team) return { ok: false, error: `choose a team for ${name}` };
    if (name in projectMap) return { ok: false, error: `${name} is listed twice` };
    projectMap[name] = team;
  }
  const dflt = defaultTeamKey.trim().toUpperCase();
  return { ok: true, body: { projectMap, defaultTeamKey: dflt || null } };
}

// the one-time reveal: the URL exists only in the response to create/rotate,
// so the card keeps it in component state and never in a refreshed server prop
export interface Reveal {
  webhookUrl: string;
}

export function revealFrom(data: unknown): Reveal | null {
  if (!data || typeof data !== "object") return null;
  const url = (data as { webhookUrl?: unknown }).webhookUrl;
  return typeof url === "string" && url.length > 0 ? { webhookUrl: url } : null;
}
