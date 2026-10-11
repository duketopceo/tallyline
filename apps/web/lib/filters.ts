import { ISSUE_STATES, PRIORITIES } from "@tallyline/types";

// List filters live in the URL so every view is linkable and a saved view is
// just this object. Server and client share the parser.
export interface Filters {
  state: string[];
  priority: string[];
  assignee: string | null; // uuid | "me" | "none" | "agent" | "human"
  label: string | null;
  project: string | null;
  cycle: string | null;
  team: string | null;
  source: string | null;
  q: string | null;
  group: string | null; // none | state | assignee | priority | project | cycle
  sort: string | null; // created | updated | priority
}

export const EMPTY_FILTERS: Filters = {
  state: [], priority: [], assignee: null, label: null, project: null,
  cycle: null, team: null, source: null, q: null, group: null, sort: null,
};

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function get(p: Params, k: string): string | undefined {
  if (p instanceof URLSearchParams) return p.get(k) ?? undefined;
  const v = p[k];
  return Array.isArray(v) ? v[0] : v;
}

const list = (v: string | undefined, allowed: readonly string[]) =>
  v ? v.split(",").filter((x) => allowed.includes(x)) : [];

export function parseFilters(p: Params): Filters {
  return {
    state: list(get(p, "state"), ISSUE_STATES),
    priority: list(get(p, "priority"), PRIORITIES),
    assignee: get(p, "assignee") ?? null,
    label: get(p, "label") ?? null,
    project: get(p, "project") ?? null,
    cycle: get(p, "cycle") ?? null,
    team: get(p, "team") ?? null,
    source: get(p, "source") ?? null,
    q: get(p, "q") ?? null,
    group: get(p, "group") ?? null,
    sort: get(p, "sort") ?? null,
  };
}

export function filtersFromObject(o: Record<string, unknown>): Filters {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) sp.set(k, v.join(","));
    else if (typeof v === "string") sp.set(k, v);
  }
  return parseFilters(sp);
}

export function filtersToQuery(f: Partial<Filters>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) ? v.length > 0 : v) sp.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return sp.toString();
}

export function filtersToObject(f: Filters): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) {
    if (Array.isArray(v) ? v.length > 0 : v) o[k] = v;
  }
  return o;
}

// number of filter dimensions in play (display options like group/sort excluded)
export function activeFilterCount(f: Filters): number {
  return (
    (f.state.length ? 1 : 0) + (f.priority.length ? 1 : 0) +
    [f.assignee, f.label, f.project, f.cycle, f.team, f.source, f.q].filter(Boolean).length
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string | null | undefined): s is string => !!s && UUID.test(s);

// the subset the API filters natively; "me"/"none"/"agent"/"human" assignee
// values are resolved client-side on the fetched page
export function apiQuery(f: Filters, me: string, limit = 200): string {
  const sp = new URLSearchParams();
  if (f.state.length) sp.set("state", f.state.join(","));
  if (f.priority.length) sp.set("priority", f.priority.join(","));
  const assignee = f.assignee === "me" ? me : f.assignee;
  if (isUuid(assignee)) sp.set("assignee", assignee);
  if (f.label) sp.set("label", f.label);
  if (f.project) sp.set("project", f.project);
  if (f.cycle) sp.set("cycle", f.cycle);
  if (f.team) sp.set("team", f.team);
  if (f.source) sp.set("source", f.source);
  if (f.q) sp.set("search", f.q);
  sp.set("limit", String(limit));
  return sp.toString();
}
