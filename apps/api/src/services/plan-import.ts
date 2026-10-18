import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  parsePlan,
  type IssueState,
  type ParsedPlan,
  type PlanEvidencePr,
  type PlanImportCandidate,
  type PlanImportDiff,
  type PlanImportRequest,
  type PlanImportUnitResult,
  type PlanUnit,
  type PlanUnitAction,
} from "@tallyline/types";
import { db } from "../db/client.js";
import {
  events,
  githubIssueLinks,
  githubRepos,
  issueExternalRefs,
  issues,
  projectMilestones,
  projects,
  teams,
} from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import { track } from "./background.js";
import { clock } from "./clock.js";
import { insertIssueTx, type Actor, type Tx } from "./issues.js";
import { queueDeliveries } from "./outbound.js";

// Plan import (U9, KTD3-KTD7): a ce-plan markdown file becomes issues in one
// project. Pure parsing lives in @tallyline/types; this service owns matching
// (Postgres only, no model) and the all-or-nothing apply.

export const MAX_PLAN_UNITS = 200;
export const SIMILARITY_THRESHOLD = 0.85;

type Exec = typeof db | Tx;

export interface ImportContext {
  workspaceId: string;
  actor: Actor;
  /** a human credential with owner or admin role: may import historical state */
  humanStaff: boolean;
}

export type PlanImportOutcome =
  | { kind: "ok"; diff: PlanImportDiff }
  | { kind: "stale"; diff: PlanImportDiff };

interface ExistingIssue {
  id: string;
  key: string;
  title: string;
  description: string | null;
  state: IssueState;
  projectId: string | null;
}

interface UnitPlan {
  unit: PlanUnit;
  scopedId: string;
  title: string;
  description: string;
  action: PlanUnitAction;
  matchedBy?: PlanImportUnitResult["matchedBy"];
  existing?: ExistingIssue;
  /** managed = the import wrote this issue's text and nobody has edited it since */
  managed: boolean;
  changes: string[];
  /** state to write: the new issue's state, or a forward move for an existing one */
  writeState?: IssueState;
  prs: PlanEvidencePr[];
  prRefsToAdd: PlanEvidencePr[];
  mergedAt?: Date;
  candidates?: PlanImportCandidate[];
  reason?: string;
}

interface Computed {
  units: UnitPlan[];
  milestonesCreate: string[];
  milestonesExisting: string[];
  warnings: string[];
  invalid: PlanImportUnitResult[];
}

const STATE_RANK: Partial<Record<IssueState, number>> = {
  triage: -1,
  backlog: 0,
  todo: 1,
  in_progress: 2,
  in_review: 3,
  done: 4,
};
const AGENT_SAFE_STATES: readonly IssueState[] = ["backlog", "todo"];
const HISTORICAL_STATES: readonly IssueState[] = ["in_progress", "done"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refId(req: PlanImportRequest, unitId: string): string {
  return `${req.plan.source.repo}:${req.plan.source.path}:${unitId}`;
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const contentHash = (title: string, description: string | null) =>
  createHash("sha256").update(`${title}\n${description ?? ""}`).digest("hex");

const footerPrefix = (req: PlanImportRequest) =>
  `Imported from ${req.plan.source.repo} ${req.plan.source.path} @ `;

function describeUnit(req: PlanImportRequest, unit: PlanUnit, inPlan: Set<string>): string {
  const { scope, source } = req.plan;
  const parts: string[] = [];
  if (unit.goal) parts.push(`**Goal:** ${unit.goal}`);
  if (unit.verification) parts.push(`**Verification:** ${unit.verification}`);
  const inside = unit.dependencies.filter((d) => inPlan.has(d)).map((d) => `${scope}-${d}`);
  const outside = unit.dependencies.filter((d) => !inPlan.has(d));
  if (inside.length || outside.length) {
    parts.push(
      `Depends on: ${inside.join(", ") || "none in this plan"}` +
        (outside.length ? ` (outside this plan: ${outside.join(", ")})` : ""),
    );
  }
  parts.push(
    `---\n${footerPrefix(req)}${source.sha.slice(0, 7)}, unit ${unit.id}.` +
      (source.url ? ` ${source.url}` : ""),
  );
  return parts.join("\n\n").slice(0, 50_000);
}

async function resolveProjectAndTeam(exec: Exec, ws: string, req: PlanImportRequest) {
  const [project] = await exec
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, ws),
        UUID.test(req.project) ? eq(projects.id, req.project) : eq(projects.name, req.project),
      ),
    )
    .limit(1);
  if (!project) throw new HttpError(404, "NOT_FOUND", "project not found");

  const teamFilter = req.teamKey
    ? and(eq(teams.workspaceId, ws), eq(teams.key, req.teamKey))
    : project.teamId
      ? and(eq(teams.workspaceId, ws), eq(teams.id, project.teamId))
      : eq(teams.workspaceId, ws);
  const [team] = await exec.select().from(teams).where(teamFilter).orderBy(asc(teams.createdAt)).limit(1);
  if (!team) {
    throw new HttpError(404, "NOT_FOUND", req.teamKey ? `team '${req.teamKey}' not found` : "no team in workspace");
  }
  return { project, team };
}

const NORM = (col: unknown) =>
  sql`btrim(regexp_replace(lower(regexp_replace(${col}, '^(\\[[^\\]]*\\]\\s*)+', '')), '[^a-z0-9]+', ' ', 'g'))`;

function normTitle(t: string): string {
  return t
    .replace(/^(\[[^\]]*\]\s*)+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function compute(
  exec: Exec,
  ctx: ImportContext,
  req: PlanImportRequest,
  parsed: ParsedPlan,
  projectId: string,
): Promise<Computed> {
  const ws = ctx.workspaceId;
  const { scope, source } = req.plan;
  const warnings: string[] = [];
  const evidence = req.evidence ?? {};
  const resolutions = req.resolutions ?? {};
  const inPlan = new Set(parsed.units.map((u) => u.id));
  const allowed = req.historical ? [...AGENT_SAFE_STATES, ...HISTORICAL_STATES] : AGENT_SAFE_STATES;

  for (const id of Object.keys(evidence)) {
    if (!inPlan.has(id)) warnings.push(`evidence names ${id}, which is not a unit of this plan`);
  }
  for (const k of Object.keys(resolutions)) {
    if (!parsed.units.some((u) => `${scope}-${u.id}` === k)) {
      warnings.push(`resolution ${k} does not match a unit of this plan`);
    }
  }
  if (
    !req.historical &&
    Object.values(evidence).some((e) => e.state && HISTORICAL_STATES.includes(e.state))
  ) {
    warnings.push("evidence states done and in_progress are ignored unless `historical` is true");
  }

  // layer 1: plan refs written by an earlier import
  const refIds = parsed.units.map((u) => refId(req, u.id));
  const refRows = refIds.length
    ? await exec
        .select({
          externalId: issueExternalRefs.externalId,
          contentHash: issueExternalRefs.contentHash,
          issue: issues,
        })
        .from(issueExternalRefs)
        .innerJoin(issues, eq(issues.id, issueExternalRefs.issueId))
        .where(
          and(
            eq(issueExternalRefs.workspaceId, ws),
            eq(issueExternalRefs.system, "plan"),
            eq(issues.workspaceId, ws),
            inArray(issueExternalRefs.externalId, refIds),
          ),
        )
    : [];
  const byRef = new Map(refRows.map((r) => [r.externalId, r.issue as ExistingIssue]));
  const hashByRef = new Map(refRows.map((r) => [r.externalId, r.contentHash]));

  // issues already owned by this plan file are excluded from fuzzy matching in
  // SQL, so siblings never look like matches of each other
  const prefix = `${source.repo}:${source.path}:`;

  // resolutions: existing issue by key
  const resolvedKeys = [...new Set(Object.values(resolutions))];
  const resolvedRows = resolvedKeys.length
    ? await exec
        .select()
        .from(issues)
        .where(and(eq(issues.workspaceId, ws), inArray(issues.key, resolvedKeys)))
    : [];
  const byKey = new Map(resolvedRows.map((r) => [r.key, r as ExistingIssue]));
  for (const [scoped, key] of Object.entries(resolutions)) {
    if (!byKey.has(key)) {
      throw new HttpError(422, "UNKNOWN_RESOLUTION", `resolution ${scoped} names ${key}, which is not an issue in this workspace`);
    }
  }

  // layer 2 candidates: any issue whose title carries a unit-looking id
  const titled = await exec.execute(sql`
    select id, key, title, state, project_id as "projectId",
           (description is not null and position(${source.path} in description) > 0) as "mentionsSource"
    from issues
    where workspace_id = ${ws} and title ~ 'U[0-9]+'
  `);
  const titledRows = titled.rows as unknown as (Pick<ExistingIssue, "id" | "key" | "title" | "state" | "projectId"> & {
    mentionsSource: boolean;
  })[];

  // layer 3: github links
  const wanted = parsed.units.flatMap((u) => u.githubIssues);
  const linkRows = wanted.length
    ? await exec
        .select({
          repo: githubRepos.fullName,
          number: githubIssueLinks.ghIssueNumber,
          issue: issues,
        })
        .from(githubIssueLinks)
        .innerJoin(
          githubRepos,
          and(eq(githubRepos.id, githubIssueLinks.repoId), eq(githubRepos.workspaceId, ws)),
        )
        .innerJoin(
          issues,
          and(eq(issues.id, githubIssueLinks.issueId), eq(issues.workspaceId, ws)),
        )
        .where(
          and(
            eq(githubIssueLinks.workspaceId, ws),
            inArray(githubRepos.fullName, [...new Set(wanted.map((w) => w.repo))]),
            inArray(githubIssueLinks.ghIssueNumber, [...new Set(wanted.map((w) => w.number))]),
          ),
        )
    : [];

  const units: UnitPlan[] = [];
  for (const unit of parsed.units) {
    const scopedId = `${scope}-${unit.id}`;
    const title = `[${scopedId}] ${unit.title}`.slice(0, 500);
    const ev = evidence[unit.id];
    const prs = ev?.prs ?? [];
    const base: UnitPlan = {
      unit,
      scopedId,
      title,
      description: describeUnit(req, unit, inPlan),
      action: "create",
      managed: false,
      changes: [],
      prs,
      prRefsToAdd: [],
      ...(ev?.mergedAt ? { mergedAt: new Date(ev.mergedAt) } : {}),
    };

    let existing: ExistingIssue | undefined = byRef.get(refId(req, unit.id));
    let matchedBy: PlanImportUnitResult["matchedBy"];
    if (existing) {
      matchedBy = "ref";
      // Only text the import itself wrote follows the plan, and only while it
      // still matches the hash stored at the last write. An adopted issue (no
      // hash) keeps its text; an edited one keeps the edit and the diff warns.
      const stored = hashByRef.get(refId(req, unit.id));
      if (stored) {
        if (contentHash(existing.title, existing.description) === stored) base.managed = true;
        else warnings.push(`${existing.key} (${scopedId}) was edited by hand since the last import; its title and description were left alone`);
      }
    } else {
      const resolved = resolutions[scopedId];
      if (resolved) {
        existing = byKey.get(resolved);
        matchedBy = "resolution";
      }
    }

    if (!existing) {
      const scopedRe = new RegExp(`(?<![A-Za-z0-9])${scopedId}(?![0-9])`);
      const bareRe = new RegExp(`(?<![A-Za-z0-9-])${unit.id}(?![0-9])`);
      const scoped = titledRows.filter((r) => scopedRe.test(r.title));
      const bare = titledRows.filter((r) => !scopedRe.test(r.title) && bareRe.test(r.title));
      const agreeing = bare.filter((r) => r.mentionsSource);
      const toCandidate = (
        r: { key: string; title: string },
        reason: PlanImportCandidate["reason"],
      ): PlanImportCandidate => ({ key: r.key, title: r.title, reason });
      if (scoped.length === 1) {
        existing = scoped[0] as unknown as ExistingIssue;
        matchedBy = "scoped_id";
      } else if (scoped.length > 1) {
        base.action = "ambiguous";
        base.reason = `${scopedId} appears in ${scoped.length} issue titles`;
        base.candidates = scoped.map((r) => toCandidate(r, "multiple_scoped_id"));
      } else if (agreeing.length === 1 && bare.length === 1) {
        existing = agreeing[0] as unknown as ExistingIssue;
        matchedBy = "bare_id";
      } else if (bare.length > 0) {
        base.action = "ambiguous";
        base.reason = `a bare ${unit.id} in a title without a plan scope; supply a resolution`;
        base.candidates = bare.map((r) => toCandidate(r, "bare_id"));
      }
    }

    if (!existing && base.action !== "ambiguous") {
      const link = unit.githubIssues
        .map((g) => linkRows.find((l) => l.repo === g.repo && l.number === g.number))
        .find((l) => l !== undefined);
      if (link) {
        existing = link.issue as ExistingIssue;
        matchedBy = "github_link";
      }
    }

    if (!existing && base.action !== "ambiguous") {
      const needle = normTitle(unit.title);
      if (needle) {
        const sim = await exec.execute(sql`
          select id, key, title, similarity(${NORM(sql.raw("title"))}, ${needle}) as score
          from issues
          where workspace_id = ${ws}
            and similarity(${NORM(sql.raw("title"))}, ${needle}) >= ${SIMILARITY_THRESHOLD}
            and not exists (
              select 1 from issue_external_refs r
              where r.issue_id = issues.id and r.system = 'plan'
                and starts_with(r.external_id, ${prefix})
            )
          order by score desc
          limit 3
        `);
        const hits = (sim.rows as unknown as { id: string; key: string; title: string; score: number }[])
;
        if (hits.length) {
          base.action = "ambiguous";
          base.reason = `similar to an existing issue title (${hits[0]!.score.toFixed(2)})`;
          base.candidates = hits.map((r) => ({
            key: r.key,
            title: r.title,
            reason: "similar_title",
            score: Number(Number(r.score).toFixed(2)),
          }));
        }
      }
    }

    // desired state from evidence (forward only for an existing issue)
    const wantState = ev?.state && allowed.includes(ev.state) ? ev.state : undefined;

    if (existing) {
      base.existing = existing;
      if (matchedBy) base.matchedBy = matchedBy;
      if (base.managed) {
        if (existing.title !== title) base.changes.push("title");
        if ((existing.description ?? "") !== base.description) base.changes.push("description");
      }
      if (matchedBy !== "ref") base.changes.push("ref");
      if (existing.projectId === null) base.changes.push("project");
      else if (existing.projectId !== projectId) {
        warnings.push(`${existing.key} (${scopedId}) already belongs to another project and was not moved`);
      }
      const cur = STATE_RANK[existing.state];
      const to = wantState === undefined ? undefined : STATE_RANK[wantState];
      if (wantState && cur !== undefined && to !== undefined && to > cur) {
        base.writeState = wantState;
        base.changes.push("state");
      }
      if (prs.length) {
        const ids = prs.map((p) => `${p.repo}#${p.number}:${existing!.key}`);
        const have = await exec
          .select({ externalId: issueExternalRefs.externalId })
          .from(issueExternalRefs)
          .where(
            and(
              eq(issueExternalRefs.workspaceId, ws),
              eq(issueExternalRefs.system, "github_pr"),
              inArray(issueExternalRefs.externalId, ids),
            ),
          );
        const haveSet = new Set(have.map((h) => h.externalId));
        base.prRefsToAdd = prs.filter((p) => !haveSet.has(`${p.repo}#${p.number}:${existing!.key}`));
        if (base.prRefsToAdd.length) base.changes.push("pr_links");
      }
      base.action = base.changes.length ? "update" : "unchanged";
    } else if (base.action === "create") {
      base.writeState = wantState ?? "backlog";
      base.prRefsToAdd = prs;
    }
    units.push(base);
  }

  const claimed = new Map<string, string>();
  for (const u of units) {
    if (!u.existing) continue;
    const other = claimed.get(u.existing.id);
    if (other) {
      throw new HttpError(422, "DUPLICATE_MATCH", `${other} and ${u.scopedId} both match ${u.existing.key}; resolve one of them to a different issue`);
    }
    claimed.set(u.existing.id, u.scopedId);
  }

  // phases become milestones
  const phaseNames = [
    ...new Set(
      parsed.phases
        .filter((p) => p.unitIds.some((id) => inPlan.has(id)) || parsed.units.some((u) => u.phase === p.name))
        .map((p) => p.name),
    ),
  ];
  const have = phaseNames.length
    ? await exec
        .select({ title: projectMilestones.title })
        .from(projectMilestones)
        .where(and(eq(projectMilestones.projectId, projectId), inArray(projectMilestones.title, phaseNames)))
    : [];
  const haveSet = new Set(have.map((h) => h.title));

  const invalid: PlanImportUnitResult[] = parsed.problems.map((p) => ({
    unitId: p.unitId,
    scopedId: `${scope}-${p.unitId}`,
    title: "",
    action: "invalid" as const,
    reason: `line ${p.line}: ${p.message}`,
  }));

  return {
    units,
    milestonesCreate: phaseNames.filter((n) => !haveSet.has(n)),
    milestonesExisting: phaseNames.filter((n) => haveSet.has(n)),
    warnings,
    invalid,
  };
}

function toDiff(
  mode: "dry_run" | "apply",
  c: Computed,
  hash: string,
  applied?: PlanImportDiff["applied"],
): PlanImportDiff {
  const units: PlanImportUnitResult[] = [
    ...c.units.map((u) => ({
      unitId: u.unit.id,
      scopedId: u.scopedId,
      title: u.title,
      action: u.action,
      ...(u.existing ? { issueKey: u.existing.key } : {}),
      ...(u.matchedBy ? { matchedBy: u.matchedBy } : {}),
      ...(u.changes.length ? { changes: u.changes } : {}),
      ...(u.writeState ? { state: u.writeState } : {}),
      ...(u.candidates ? { candidates: u.candidates } : {}),
      ...(u.reason ? { reason: u.reason } : {}),
    })),
    ...c.invalid,
  ];
  const counts: Record<PlanUnitAction, number> = { create: 0, update: 0, unchanged: 0, ambiguous: 0, invalid: 0 };
  for (const u of units) counts[u.action]++;
  return {
    mode,
    diffHash: hash,
    counts,
    units,
    milestones: { create: c.milestonesCreate, existing: c.milestonesExisting },
    warnings: c.warnings,
    ...(applied ? { applied } : {}),
  };
}

// covers the input and the computed per-unit action set, so a change in the
// plan, the evidence, the resolutions or the workspace all change the hash
function hashOf(
  req: PlanImportRequest,
  ids: { projectId: string; teamId: string },
  c: Computed,
): string {
  return createHash("sha256")
    .update(
      stable({
        ids,
        scope: req.plan.scope,
        source: req.plan.source,
        markdown: req.plan.markdown,
        evidence: req.evidence ?? {},
        historical: req.historical ?? false,
        resolutions: req.resolutions ?? {},
        actions: [
          ...c.units.map((u) => ({
            id: u.unit.id,
            action: u.action,
            key: u.existing?.key ?? null,
            changes: u.changes,
            state: u.writeState ?? null,
            candidates: u.candidates?.map((x) => x.key) ?? [],
          })),
          ...c.invalid.map((u) => ({ id: u.unitId, action: u.action })),
        ],
        milestones: c.milestonesCreate,
      }),
    )
    .digest("hex");
}

export async function importPlan(ctx: ImportContext, req: PlanImportRequest): Promise<PlanImportOutcome> {
  const mode = req.mode ?? "dry_run";
  const parsed = parsePlan(req.plan.markdown);
  if (parsed.units.length === 0 && parsed.problems.length === 0) {
    throw new HttpError(422, "NO_UNITS", "no `### U<N>. title` units found in the plan");
  }
  if (parsed.units.length + parsed.problems.length > MAX_PLAN_UNITS) {
    throw new HttpError(
      422,
      "PLAN_TOO_LARGE",
      `plan has more than ${MAX_PLAN_UNITS} units; split it before importing`,
    );
  }

  // Historical state is a human owner/admin decision (KTD6). Checked before
  // any read so a refused call has no side effects, whatever `historical` says.
  const wantsHistory =
    req.historical === true ||
    Object.values(req.evidence ?? {}).some(
      (e) => (e.state && HISTORICAL_STATES.includes(e.state)) || e.prs?.length || e.mergedAt,
    );
  if (wantsHistory && !ctx.humanStaff) {
    throw new HttpError(
      403,
      "FORBIDDEN_HISTORICAL",
      "importing done or in-progress state requires a human owner or admin credential",
    );
  }

  const nowMs = clock.ms();
  for (const [id, e] of Object.entries(req.evidence ?? {})) {
    if (e.mergedAt && Date.parse(e.mergedAt) > nowMs) {
      throw new HttpError(422, "INVALID_EVIDENCE", `evidence for ${id} has a mergedAt in the future`);
    }
  }

  const { project, team } = await resolveProjectAndTeam(db, ctx.workspaceId, req);
  const ids = { projectId: project.id, teamId: team.id };

  if (mode === "dry_run") {
    const c = await compute(db, ctx, req, parsed, project.id);
    return { kind: "ok", diff: toDiff("dry_run", c, hashOf(req, ids, c)) };
  }
  if (!req.diffHash) {
    throw new HttpError(400, "DIFF_HASH_REQUIRED", "apply needs the diffHash from a reviewed dry run");
  }

  const result = await db.transaction(async (tx) => {
    // Imports in one workspace run one at a time (matching reads what other
    // imports write), and one apply per plan file; the diff is recomputed
    // under the locks.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`plan-import:${ctx.workspaceId}`}))`);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`plan-import:${ctx.workspaceId}:${req.plan.source.repo}:${req.plan.source.path}`}))`,
    );
    const c = await compute(tx, ctx, req, parsed, project.id);
    const hash = hashOf(req, ids, c);
    if (hash !== req.diffHash) return { kind: "stale" as const, diff: toDiff("dry_run", c, hash) };

    const applied: NonNullable<PlanImportDiff["applied"]> = { created: [], updated: [] };
    const createdForHooks: { id: string; key: string; title: string; state: IssueState }[] = [];
    const now = clock.now();

    for (const title of c.milestonesCreate) {
      await tx
        .insert(projectMilestones)
        .values({ workspaceId: ctx.workspaceId, projectId: project.id, title })
        .onConflictDoNothing();
    }

    const planRef = async (u: UnitPlan, issueId: string, hash: string | null) => {
      await tx
        .insert(issueExternalRefs)
        .values({
          workspaceId: ctx.workspaceId,
          issueId,
          system: "plan",
          externalId: refId(req, u.unit.id),
          url: req.plan.source.url ?? null,
          contentHash: hash,
        })
        .onConflictDoNothing();
    };
    const prRefs = async (u: UnitPlan, issueId: string, key: string) => {
      for (const p of u.prRefsToAdd) {
        await tx
          .insert(issueExternalRefs)
          .values({
            workspaceId: ctx.workspaceId,
            issueId,
            system: "github_pr",
            externalId: `${p.repo}#${p.number}:${key}`,
            url: `https://github.com/${p.repo}/pull/${p.number}`,
          })
          .onConflictDoNothing();
      }
    };
    const evidenceAfter = (u: UnitPlan) => ({
      ...(u.prs.length ? { prs: u.prs.map((p) => ({ repo: p.repo, number: p.number })) } : {}),
      ...(u.mergedAt ? { mergedAt: u.mergedAt.toISOString() } : {}),
    });

    for (const u of c.units) {
      if (u.action === "create") {
        const state = u.writeState ?? "backlog";
        const historical = HISTORICAL_STATES.includes(state) || u.prs.length > 0;
        const issue = await insertIssueTx(tx, {
          workspaceId: ctx.workspaceId,
          teamId: team.id,
          title: u.title,
          description: u.description,
          source: "api",
          creator: ctx.actor,
          state,
          projectId: project.id,
          event: {
            action: historical ? "imported" : "created",
            after: (key) => ({
              key,
              title: u.title,
              state,
              plan: { scope: req.plan.scope, unit: u.unit.id, repo: req.plan.source.repo, path: req.plan.source.path, sha: req.plan.source.sha },
              ...evidenceAfter(u),
            }),
            ...(historical && u.mergedAt && state === "done" ? { createdAt: u.mergedAt } : {}),
          },
        });
        await planRef(u, issue.id, contentHash(issue.title, issue.description));
        await prRefs(u, issue.id, issue.key);
        applied.created.push({ unitId: u.unit.id, key: issue.key });
        createdForHooks.push({ id: issue.id, key: issue.key, title: issue.title, state: issue.state });
      } else if (u.action === "update" && u.existing) {
        const e = u.existing;
        const set: Partial<typeof issues.$inferInsert> = {};
        const before: Record<string, unknown> = {};
        const after: Record<string, unknown> = {};
        if (u.changes.includes("title")) {
          set.title = u.title;
          before.title = e.title;
          after.title = u.title;
        }
        if (u.changes.includes("description")) set.description = u.description;
        if (u.changes.includes("project")) {
          set.projectId = project.id;
          before.projectId = e.projectId;
          after.projectId = project.id;
        }
        if (u.changes.includes("state") && u.writeState) {
          set.state = u.writeState;
          before.state = e.state;
          after.state = u.writeState;
        }
        if (Object.keys(set).length) {
          set.updatedAt = now;
          await tx.update(issues).set(set).where(eq(issues.id, e.id));
        }
        if (u.changes.includes("ref")) await planRef(u, e.id, null);
        if (set.title !== undefined || set.description !== undefined) {
          await tx
            .update(issueExternalRefs)
            .set({ contentHash: contentHash(set.title ?? e.title, set.description ?? e.description) })
            .where(
              and(
                eq(issueExternalRefs.workspaceId, ctx.workspaceId),
                eq(issueExternalRefs.system, "plan"),
                eq(issueExternalRefs.externalId, refId(req, u.unit.id)),
              ),
            );
        }
        await prRefs(u, e.id, e.key);
        await tx.insert(events).values({
          workspaceId: ctx.workspaceId,
          entityType: "issue",
          entityId: e.id,
          action: "imported",
          actorType: ctx.actor.type,
          actorId: ctx.actor.id,
          before,
          after: {
            ...after,
            changes: u.changes,
            plan: { scope: req.plan.scope, unit: u.unit.id, repo: req.plan.source.repo, path: req.plan.source.path, sha: req.plan.source.sha },
            ...evidenceAfter(u),
          },
          ...(u.writeState === "done" && u.mergedAt ? { createdAt: u.mergedAt } : {}),
        });
        applied.updated.push({ unitId: u.unit.id, key: e.key });
      }
    }
    return { kind: "ok" as const, diff: toDiff("apply", c, hash, applied), createdForHooks };
  });

  if (result.kind === "stale") return result;
  for (const i of result.createdForHooks) {
    track(
      queueDeliveries({
        workspaceId: ctx.workspaceId,
        entityType: "issue",
        entityId: i.id,
        action: "created",
        actorType: ctx.actor.type,
        actorId: ctx.actor.id,
        after: { key: i.key, title: i.title, state: i.state },
        issueKey: i.key,
      }),
    );
  }
  return { kind: "ok", diff: result.diff };
}
