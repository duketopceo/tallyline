import { randomBytes } from "node:crypto";
import { db } from "../src/db/client.js";
import {
  agents,
  authProviders,
  comments,
  cycles,
  cycleVelocity,
  dispatchEvents,
  dispatches,
  events,
  githubInstallations,
  githubIssueLinks,
  githubRepos,
  invites,
  issueExternalRefs,
  issueLabels,
  intakeEvents,
  issues,
  labels,
  notifications,
  oauthCodes,
  oauthGrants,
  projectMilestones,
  projects,
  slackLinks,
  teams,
  users,
  views,
  webhookDeliveries,
  webhookEndpoints,
  workspaceMembers,
  workspaces,
} from "../src/db/schema.js";
import { RESOURCE } from "../src/services/mcp-oauth.js";
import { createAgentKey } from "../src/services/agents.js";
import { createSession, hashPassword } from "../src/services/auth.js";
import { createUserToken, hashToken } from "../src/services/tokens.js";

// Two-tenant fixture shared by the permission matrix and the tenancy suite.
// Tenants are created through the same tables the API reads, with every
// tenant-scoped entity populated. Tenant A is created first, so its owner is
// the instance admin (AUTH_ADMIN_EMAILS unset => bootstrap owner).

// random per run: nothing credential-shaped is checked in
export const PASSWORD = `pw-${randomBytes(12).toString("hex")}`;
let passwordHash: string | null = null;

export type Role = "owner" | "admin" | "member";

export interface Person {
  id: string;
  email: string;
  memberRowId: string;
}

export interface Tenant {
  label: string;
  ws: { id: string; slug: string };
  team: { id: string; key: string };
  people: Record<Role, Person>;
  agent: { id: string; name: string };
  agentKeys: { read: string; write: string; readId: string; writeId: string };
  pats: { read: string; write: string; readId: string; writeId: string };
  /** marker embedded in every text field so leaks are greppable */
  sentinel: string;
}

const uniq = () => randomBytes(4).toString("hex");

export async function seedTenant(label: string, teamKey: string): Promise<Tenant> {
  passwordHash ??= hashPassword(PASSWORD);
  const run = uniq();
  const sentinel = `tlysentinel${label}${run}`;
  const [ws] = await db
    .insert(workspaces)
    .values({ slug: `tenant-${label}-${run}`, name: `Tenant ${sentinel}` })
    .returning();
  const [team] = await db
    .insert(teams)
    .values({ workspaceId: ws!.id, key: teamKey, name: `Team ${sentinel}` })
    .returning();

  const people = {} as Record<Role, Person>;
  for (const role of ["owner", "admin", "member"] as const) {
    const email = `${role}-${label}-${run}@matrix.test`;
    const [u] = await db
      .insert(users)
      .values({ email, name: `${role} ${sentinel}`, passwordHash })
      .returning();
    const [m] = await db
      .insert(workspaceMembers)
      .values({ workspaceId: ws!.id, userId: u!.id, role })
      .returning();
    people[role] = { id: u!.id, email, memberRowId: m!.id };
  }

  const [agent] = await db
    .insert(agents)
    .values({
      workspaceId: ws!.id,
      name: `bot-${label}-${run}`,
      harness: "test",
      endpointUrl: `http://127.0.0.1:9/${sentinel}`,
      endpointSecret: `endpoint-secret-${sentinel}`,
    })
    .returning();
  const kr = await createAgentKey(agent!.id, ws!.id, "read", ["read"]);
  const kw = await createAgentKey(agent!.id, ws!.id, "write", ["read", "write"]);
  const pr = await createUserToken(people.owner.id, ws!.id, "read", ["read"]);
  const pw = await createUserToken(people.owner.id, ws!.id, "write", ["read", "write"]);

  return {
    label,
    ws: { id: ws!.id, slug: ws!.slug },
    team: { id: team!.id, key: teamKey },
    people,
    agent: { id: agent!.id, name: agent!.name },
    agentKeys: { read: kr.key, write: kw.key, readId: kr.id, writeId: kw.id },
    pats: { read: pr.token, write: pw.token, readId: pr.id, writeId: pw.id },
    sentinel,
  };
}

/** a fresh cookie-session token for one of the tenant's people */
export async function newSession(t: Tenant, role: Role): Promise<string> {
  return createSession(t.people[role].id, t.ws.id);
}

// ── entity makers ────────────────────────────────────────────────────────────
// Each creates one fresh row in the tenant, so destructive operations never
// run out of targets and denial is always observed against a real resource.

let issueSeq = 100;

export async function mkIssue(
  t: Tenant,
  over: Partial<typeof issues.$inferInsert> = {},
) {
  const number = ++issueSeq + Math.floor(Math.random() * 1_000_000);
  const [row] = await db
    .insert(issues)
    .values({
      workspaceId: t.ws.id,
      teamId: t.team.id,
      key: `${t.team.key}-${number}`,
      number,
      title: `Issue ${t.sentinel}`,
      description: `desc ${t.sentinel}`,
      ...over,
    })
    .returning();
  return row!;
}

export async function mkProject(t: Tenant) {
  const [row] = await db
    .insert(projects)
    .values({ workspaceId: t.ws.id, name: `Project ${t.sentinel}`, description: t.sentinel })
    .returning();
  return row!;
}

export async function mkMilestone(t: Tenant, projectId: string) {
  const [row] = await db
    .insert(projectMilestones)
    .values({ workspaceId: t.ws.id, projectId, title: `Milestone ${t.sentinel}` })
    .returning();
  return row!;
}

let cycleSeq = 1;
export async function mkCycle(t: Tenant, over: Partial<typeof cycles.$inferInsert> = {}) {
  const [row] = await db
    .insert(cycles)
    .values({
      workspaceId: t.ws.id,
      teamId: t.team.id,
      name: `Cycle ${t.sentinel}`,
      number: ++cycleSeq + Math.floor(Math.random() * 1_000_000),
      startsAt: new Date("2026-10-01T00:00:00Z"),
      endsAt: new Date("2026-10-14T00:00:00Z"),
      ...over,
    })
    .returning();
  return row!;
}

export async function mkLabel(t: Tenant) {
  const [row] = await db
    .insert(labels)
    .values({ workspaceId: t.ws.id, name: `label-${t.sentinel}-${uniq()}`, color: "#aabbcc" })
    .returning();
  return row!;
}

export async function mkComment(t: Tenant, issueId: string) {
  const [row] = await db
    .insert(comments)
    .values({
      workspaceId: t.ws.id,
      issueId,
      actorType: "human",
      actorId: t.people.owner.id,
      body: `comment ${t.sentinel}`,
    })
    .returning();
  return row!;
}

export async function mkEvent(t: Tenant, entityId: string) {
  const [row] = await db
    .insert(events)
    .values({
      workspaceId: t.ws.id,
      entityType: "issue",
      entityId,
      action: "issue_created",
      actorType: "human",
      actorId: t.people.owner.id,
      after: { note: t.sentinel },
    })
    .returning();
  return row!;
}

export async function mkView(t: Tenant, ownerId: string) {
  const [row] = await db
    .insert(views)
    .values({
      workspaceId: t.ws.id,
      ownerId,
      name: `View ${t.sentinel}`,
      filters: { note: t.sentinel },
      shared: true,
    })
    .returning();
  return row!;
}

export async function mkEndpoint(t: Tenant) {
  const [row] = await db
    .insert(webhookEndpoints)
    .values({
      workspaceId: t.ws.id,
      url: `http://127.0.0.1:9/${t.sentinel}`,
      secret: `hook-secret-${t.sentinel}-0123456789`,
    })
    .returning();
  return row!;
}

export async function mkDelivery(t: Tenant, endpointId: string) {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      workspaceId: t.ws.id,
      endpointId,
      action: "issue_created",
      payload: { note: t.sentinel },
      status: "delivered",
    })
    .returning();
  return row!;
}

export async function mkDispatch(t: Tenant, issueId: string) {
  const [row] = await db
    .insert(dispatches)
    .values({
      workspaceId: t.ws.id,
      issueId,
      agentId: t.agent.id,
      trigger: "assign",
      status: "claimed",
      commentBody: t.sentinel,
    })
    .returning();
  return row!;
}

export async function mkDispatchEvent(t: Tenant, dispatchId: string) {
  const [row] = await db
    .insert(dispatchEvents)
    .values({
      dispatchId,
      workspaceId: t.ws.id,
      kind: "note",
      message: `progress ${t.sentinel}`,
    })
    .returning();
  return row!;
}

export async function mkInvite(t: Tenant, createdBy: string) {
  const [row] = await db
    .insert(invites)
    .values({
      workspaceId: t.ws.id,
      email: `invitee-${uniq()}@matrix.test`,
      tokenHash: hashToken(`invite-${uniq()}-${uniq()}`),
      role: "member",
      createdBy,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    })
    .returning();
  return row!;
}

export async function mkMember(t: Tenant, role: Role = "member") {
  const email = `extra-${uniq()}@matrix.test`;
  const [u] = await db
    .insert(users)
    .values({ email, name: `extra ${t.sentinel}`, passwordHash: null })
    .returning();
  const [m] = await db
    .insert(workspaceMembers)
    .values({ workspaceId: t.ws.id, userId: u!.id, role })
    .returning();
  return { userId: u!.id, memberRowId: m!.id };
}

export async function mkAgent(t: Tenant) {
  const [row] = await db
    .insert(agents)
    .values({ workspaceId: t.ws.id, name: `extra-${uniq()}`, harness: "test" })
    .returning();
  return row!;
}

export async function mkOauthGrant(t: Tenant, userId: string) {
  const [agent] = await db
    .insert(agents)
    .values({ workspaceId: t.ws.id, name: `connector-${uniq()}`, harness: "mcp-connector" })
    .returning();
  const [row] = await db
    .insert(oauthGrants)
    .values({
      userId,
      workspaceId: t.ws.id,
      agentId: agent!.id,
      clientId: `tly_cli_${uniq()}`,
      clientName: `Connector ${t.sentinel}`,
      scopes: ["read"],
      resource: RESOURCE,
    })
    .returning();
  return row!;
}

export async function mkAgentKey(t: Tenant, agentId: string) {
  return createAgentKey(agentId, t.ws.id, `k-${uniq()}`, ["read"]);
}

export async function mkToken(t: Tenant, userId: string) {
  return createUserToken(userId, t.ws.id, `pat ${t.sentinel}-${uniq()}`, ["read"]);
}

export async function mkProvider(workspaceId: string | null = null) {
  const [row] = await db
    .insert(authProviders)
    .values({
      workspaceId,
      key: `prov-${uniq()}`,
      type: "github",
      label: "Matrix provider",
      clientId: "client-id",
    })
    .returning();
  return row!;
}

let ghSeq = 9_000_000;
export async function mkGithub(t: Tenant, issueId: string) {
  const installationId = ++ghSeq + Math.floor(Math.random() * 1_000_000);
  const [inst] = await db
    .insert(githubInstallations)
    .values({ workspaceId: t.ws.id, installationId, accountLogin: `acct-${t.sentinel}` })
    .returning();
  const [repo] = await db
    .insert(githubRepos)
    .values({
      workspaceId: t.ws.id,
      installationId,
      repoId: installationId,
      fullName: `matrix/${t.sentinel}`,
      teamId: t.team.id,
      enabled: true,
    })
    .returning();
  const [link] = await db
    .insert(githubIssueLinks)
    .values({
      workspaceId: t.ws.id,
      repoId: repo!.id,
      ghIssueId: installationId,
      ghIssueNumber: 7,
      issueId,
    })
    .returning();
  return { installation: inst!, repo: repo!, link: link! };
}

export async function mkExternalRef(t: Tenant, issueId: string) {
  const [row] = await db
    .insert(issueExternalRefs)
    .values({ workspaceId: t.ws.id, issueId, system: "linear", externalId: `ext-${t.sentinel}-${uniq()}` })
    .returning();
  return row!;
}

export async function mkSlackLink(t: Tenant, issueId: string) {
  const [row] = await db
    .insert(slackLinks)
    .values({ workspaceId: t.ws.id, issueId, channel: `C${uniq()}`, threadTs: `1700000000.${uniq()}` })
    .returning();
  return row!;
}

export async function mkVelocity(t: Tenant, cycleId: string) {
  const [row] = await db
    .insert(cycleVelocity)
    .values({ workspaceId: t.ws.id, teamId: t.team.id, cycleId, issueCount: 3, doneCount: 2 })
    .returning();
  return row!;
}

export async function mkOauthCode(t: Tenant, userId: string) {
  const [row] = await db
    .insert(oauthCodes)
    .values({
      codeHash: hashToken(`oauth-${uniq()}-${uniq()}`),
      purpose: "login",
      userId,
      workspaceId: t.ws.id,
      expiresAt: new Date(Date.now() + 600_000),
    })
    .returning();
  return row!;
}

export async function mkIssueLabel(issueId: string, labelId: string) {
  await db.insert(issueLabels).values({ issueId, labelId });
}

export async function mkNotification(t: Tenant, userId: string, issueId?: string) {
  const [row] = await db
    .insert(notifications)
    .values({
      workspaceId: t.ws.id,
      userId,
      kind: "assigned",
      issueId,
      actorType: "human",
      actorId: t.people.owner.id,
    })
    .returning();
  return row!;
}

export interface Entities {
  issue: Awaited<ReturnType<typeof mkIssue>>;
  triageIssue: Awaited<ReturnType<typeof mkIssue>>;
  reviewIssue: Awaited<ReturnType<typeof mkIssue>>;
  project: Awaited<ReturnType<typeof mkProject>>;
  milestone: Awaited<ReturnType<typeof mkMilestone>>;
  cycle: Awaited<ReturnType<typeof mkCycle>>;
  label: Awaited<ReturnType<typeof mkLabel>>;
  comment: Awaited<ReturnType<typeof mkComment>>;
  event: Awaited<ReturnType<typeof mkEvent>>;
  view: Awaited<ReturnType<typeof mkView>>;
  endpoint: Awaited<ReturnType<typeof mkEndpoint>>;
  delivery: Awaited<ReturnType<typeof mkDelivery>>;
  dispatch: Awaited<ReturnType<typeof mkDispatch>>;
  dispatchEvent: Awaited<ReturnType<typeof mkDispatchEvent>>;
  invite: Awaited<ReturnType<typeof mkInvite>>;
  extraMember: Awaited<ReturnType<typeof mkMember>>;
  extraAgent: Awaited<ReturnType<typeof mkAgent>>;
  agentKey: Awaited<ReturnType<typeof mkAgentKey>>;
  token: Awaited<ReturnType<typeof mkToken>>;
  github: Awaited<ReturnType<typeof mkGithub>>;
  externalRef: Awaited<ReturnType<typeof mkExternalRef>>;
  slackLink: Awaited<ReturnType<typeof mkSlackLink>>;
  velocity: Awaited<ReturnType<typeof mkVelocity>>;
  oauthCode: Awaited<ReturnType<typeof mkOauthCode>>;
  oauthGrant: Awaited<ReturnType<typeof mkOauthGrant>>;
  notification: Awaited<ReturnType<typeof mkNotification>>;
}

/** one row in every tenant-scoped table (except sessions: see newSession) */
export async function seedEntities(t: Tenant): Promise<Entities> {
  const project = await mkProject(t);
  const cycle = await mkCycle(t);
  const label = await mkLabel(t);
  const issue = await mkIssue(t, { projectId: project.id, cycleId: cycle.id, state: "in_progress" });
  const triageIssue = await mkIssue(t, { state: "triage" });
  const reviewIssue = await mkIssue(t, { state: "in_review" });
  await mkIssueLabel(issue.id, label.id);
  const endpoint = await mkEndpoint(t);
  await db
    .insert(intakeEvents)
    .values({ workspaceId: t.ws.id, provider: "matrix", issueId: issue.id });
  const dispatch = await mkDispatch(t, issue.id);
  await newSession(t, "owner"); // sessions row
  return {
    issue,
    triageIssue,
    reviewIssue,
    project,
    milestone: await mkMilestone(t, project.id),
    cycle,
    label,
    comment: await mkComment(t, issue.id),
    event: await mkEvent(t, issue.id),
    view: await mkView(t, t.people.owner.id),
    endpoint,
    delivery: await mkDelivery(t, endpoint.id),
    dispatch,
    dispatchEvent: await mkDispatchEvent(t, dispatch.id),
    invite: await mkInvite(t, t.people.owner.id),
    extraMember: await mkMember(t),
    extraAgent: await mkAgent(t),
    agentKey: await mkAgentKey(t, t.agent.id),
    token: await mkToken(t, t.people.owner.id),
    github: await mkGithub(t, issue.id),
    externalRef: await mkExternalRef(t, issue.id),
    slackLink: await mkSlackLink(t, issue.id),
    velocity: await mkVelocity(t, cycle.id),
    oauthCode: await mkOauthCode(t, t.people.owner.id),
    oauthGrant: await mkOauthGrant(t, t.people.owner.id),
    notification: await mkNotification(t, t.people.owner.id, issue.id),
  };
}
