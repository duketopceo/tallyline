import { cookies } from "next/headers";
import { api, SESSION_COOKIE } from "@/lib/api";

// Workspace reference data the shell hands to every client surface (pickers,
// filters, sidebar counts). Loaded once in the (app) layout, in parallel.
export interface Member { userId: string; name: string; email: string; role: string }
export interface AgentRef { id: string; name: string; harness: string }
export interface LabelRef { id: string; name: string; color: string }
export interface TeamRef { id: string; key: string; name: string }
export interface CycleRef { id: string; number: number; name: string | null; teamId: string; isActive: boolean }
export interface ProjectRef { id: string; name: string; teamId: string | null }
export interface ViewRef { id: string; name: string; filters: Record<string, unknown>; shared: boolean; ownerId: string }

export interface Meta {
  workspace: string;
  userId: string;
  userName: string;
  role: string | undefined;
  members: Member[];
  agents: AgentRef[];
  labels: LabelRef[];
  teams: TeamRef[];
  cycles: CycleRef[];
  projects: ProjectRef[];
  views: ViewRef[];
  counts: { triage: number; review: number };
}

// Every page render needs the workspace reference data (9 API calls). A short
// per-session cache keeps page loads from spending the user's API rate budget
// on data that rarely changes; our own mutations invalidate it.
const TTL_MS = 10_000;
// route handlers and pages can be separate module instances (dev bundling), so
// the cache lives on globalThis to be shared with the invalidating handlers
const g = globalThis as { __tlMetaCache?: Map<string, { at: number; meta: Meta }> };
const cache = (g.__tlMetaCache ??= new Map());

export function invalidateMeta(session: string | undefined) {
  if (!session) return;
  for (const k of [...cache.keys()]) if (k.startsWith(`${session}|`)) cache.delete(k);
}

export async function loadMeta(
  workspace: string,
  me: { userId: string; name: string; role: string | undefined },
): Promise<Meta> {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  const key = `${session ?? ""}|${workspace}`;
  const hit = session ? cache.get(key) : undefined;
  if (hit && Date.now() - hit.at < TTL_MS) return hit.meta;
  const meta = await fetchMeta(workspace, me);
  if (session) {
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), meta });
  }
  return meta;
}

async function fetchMeta(
  workspace: string,
  me: { userId: string; name: string; role: string | undefined },
): Promise<Meta> {
  const base = `/v1/workspaces/${workspace}`;
  const [members, agents, labels, teams, cycles, projects, views, triage, review] =
    await Promise.all([
      api<{ members: Member[] }>(`${base}/members`),
      api<{ agents: AgentRef[] }>(`${base}/agents`),
      api<{ labels: LabelRef[] }>(`${base}/labels`),
      api<{ teams: TeamRef[] }>(`${base}/teams`),
      api<{ cycles: CycleRef[] }>(`${base}/cycles`),
      api<{ projects: ProjectRef[] }>(`${base}/projects`),
      api<{ views: ViewRef[] }>(`${base}/views`),
      api<{ issues: unknown[] }>(`${base}/issues?state=triage&limit=100`),
      api<{ queue: unknown[] }>(`${base}/review-queue`),
    ]);
  return {
    workspace,
    userId: me.userId,
    userName: me.name,
    role: me.role,
    members: members.data?.members ?? [],
    agents: agents.data?.agents ?? [],
    labels: labels.data?.labels ?? [],
    teams: teams.data?.teams ?? [],
    cycles: cycles.data?.cycles ?? [],
    projects: projects.data?.projects ?? [],
    views: views.data?.views ?? [],
    counts: {
      triage: triage.data?.issues?.length ?? 0,
      review: review.data?.queue?.length ?? 0,
    },
  };
}
