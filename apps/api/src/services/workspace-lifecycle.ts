import { and, eq, isNotNull, lte } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { events, users, workspaceMembers, workspaces } from "../db/schema.js";
import { config_ } from "../env.js";
import { audit } from "./account.js";
import { clock } from "./clock.js";
import { TENANT_JOIN_TABLES, TENANT_TABLES } from "./tenant-tables.js";

// Workspace soft delete, restore, hard delete (purge) and export.

export const EXPORT_FORMAT = "tallyline-workspace-export";
export const EXPORT_VERSION = 1;
const PAGE = 1000;

export type Write = (chunk: string) => Promise<void>;

export async function scheduleWorkspaceDeletion(wsId: string, userId: string) {
  const now = clock.now();
  const purgeAfter = new Date(now.getTime() + config_.workspacePurgeDays * 86_400_000);
  const [ws] = await db
    .update(workspaces)
    .set({ deletedAt: now, purgeAfter, deletedBy: userId })
    .where(eq(workspaces.id, wsId))
    .returning();
  await db.insert(events).values({
    workspaceId: wsId,
    entityType: "workspace",
    entityId: wsId,
    action: "workspace_deletion_scheduled",
    actorType: "human",
    actorId: userId,
    after: { purgeAfter: purgeAfter.toISOString() },
  });
  await audit("workspace_deletion_scheduled", { userId, meta: { workspaceId: wsId } });
  return ws!;
}

export async function restoreWorkspace(wsId: string, userId: string) {
  const [ws] = await db
    .update(workspaces)
    .set({ deletedAt: null, purgeAfter: null, deletedBy: null })
    .where(and(eq(workspaces.id, wsId), isNotNull(workspaces.deletedAt)))
    .returning();
  if (!ws) return null;
  await db.insert(events).values({
    workspaceId: wsId,
    entityType: "workspace",
    entityId: wsId,
    action: "workspace_restored",
    actorType: "human",
    actorId: userId,
  });
  await audit("workspace_restored", { userId, meta: { workspaceId: wsId } });
  return ws;
}

/**
 * Tenant tables ordered children-first by their foreign keys, read from the
 * live catalog so a new FK can never make the purge fail mid-way.
 */
async function purgeOrder(client: { query: typeof pool.query }): Promise<string[]> {
  const tables = Object.keys(TENANT_TABLES);
  const { rows } = await client.query<{ child: string; parent: string }>(
    `select cl.relname as child, pl.relname as parent
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_class pl on pl.oid = c.confrelid
       join pg_namespace n on n.oid = cl.relnamespace
      where c.contype = 'f' and n.nspname = 'public'`,
  );
  const parentsOf = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const r of rows) {
    if (r.child === r.parent) continue;
    if (parentsOf.has(r.child) && parentsOf.has(r.parent)) parentsOf.get(r.child)!.add(r.parent);
  }
  // a table may be deleted once nothing still pending references it
  const order: string[] = [];
  const pending = new Set(tables);
  while (pending.size > 0) {
    const ready = [...pending].filter(
      (t) => ![...pending].some((other) => other !== t && parentsOf.get(other)!.has(t)),
    );
    if (ready.length === 0) throw new Error(`FK cycle among tenant tables: ${[...pending].join(", ")}`);
    for (const t of ready.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }
  return order;
}

/** hard delete: every tenant row, then the workspace. Irreversible. */
export async function purgeWorkspace(wsId: string): Promise<Record<string, number>> {
  const client = await pool.connect();
  const counts: Record<string, number> = {};
  try {
    await client.query("BEGIN");
    const order = await purgeOrder(client);
    // issues.parent_id has no FK, so issues can be removed in one statement
    for (const table of order) {
      const r = await client.query(`delete from "${table}" where workspace_id = $1`, [wsId]);
      counts[table] = r.rowCount ?? 0;
    }
    const ws = await client.query(`delete from workspaces where id = $1`, [wsId]);
    counts.workspaces = ws.rowCount ?? 0;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  await audit("workspace_purged", { userId: null, actorUserId: null, meta: { workspaceId: wsId } });
  return counts;
}

/** the purge job: hard-deletes every workspace whose restore window closed */
export async function sweepDeletedWorkspaces(): Promise<string[]> {
  const due = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(isNotNull(workspaces.deletedAt), lte(workspaces.purgeAfter, clock.now())));
  const purged: string[] = [];
  for (const { id } of due) {
    // re-check inside the purge path: a restore may have landed meanwhile
    const [still] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(eq(workspaces.id, id), isNotNull(workspaces.deletedAt), lte(workspaces.purgeAfter, clock.now())),
      );
    if (!still) continue;
    await purgeWorkspace(id);
    purged.push(id);
  }
  return purged;
}

// ── export ───────────────────────────────────────────────────────────────────

function redact(row: Record<string, unknown>, cols: string[] | undefined) {
  if (!cols) return row;
  for (const c of cols) if (c in row) row[c] = "[redacted]";
  return row;
}

type Query = <R extends Record<string, unknown>>(
  text: string,
  params: unknown[],
) => Promise<{ rows: R[] }>;

/**
 * Runs an export inside one REPEATABLE READ, READ ONLY transaction, so the
 * paged reads see a single consistent snapshot even while the workspace is
 * being written to.
 */
async function withSnapshot(fn: (q: Query) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await fn((text, params) => client.query(text, params));
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function streamRows(
  q: Query,
  write: Write,
  sqlText: string,
  params: unknown[],
  redactCols?: string[],
): Promise<number> {
  let offset = 0;
  let n = 0;
  for (;;) {
    const { rows } = await q<Record<string, unknown>>(
      `${sqlText} limit ${PAGE} offset ${offset}`,
      params,
    );
    for (const row of rows) {
      await write(`${n === 0 ? "" : ","}\n${JSON.stringify(redact(row, redactCols))}`);
      n++;
    }
    if (rows.length < PAGE) return n;
    offset += PAGE;
  }
}

/**
 * Streams the whole workspace as one JSON document:
 * { format, version, exportedAt, workspace, members, tables: {name: rows[]},
 *   attachments: { items: [] }, counts }
 * Every exportable table from TENANT_TABLES is included; credentials are
 * redacted. Tallyline stores no binary attachments yet, so the attachments
 * manifest is empty — the key is there so importers can rely on its shape.
 */
export async function streamWorkspaceExport(wsId: string, write: Write): Promise<void> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId));
  if (!ws) throw new Error("workspace not found");
  const members = await db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.createdAt,
      name: users.name,
      email: users.email,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, wsId));
  const head = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: clock.now().toISOString(),
    workspace: {
      id: ws.id,
      slug: ws.slug,
      name: ws.name,
      allowedDomains: ws.allowedDomains,
      createdAt: ws.createdAt,
      deletedAt: ws.deletedAt,
      purgeAfter: ws.purgeAfter,
    },
    members,
  };
  const headJson = JSON.stringify(head);
  await withSnapshot(async (q) => {
    await write(`${headJson.slice(0, -1)},"tables":{`);
    const counts: Record<string, number> = {};
    let first = true;
    const tables = Object.entries(TENANT_TABLES).filter(([, p]) => p.export);
    for (const [table, policy] of tables) {
      await write(`${first ? "" : ","}\n${JSON.stringify(table)}:[`);
      first = false;
      counts[table] = await streamRows(
        q,
        write,
        `select * from "${table}" where workspace_id = $1 order by id`,
        [wsId],
        policy.redact,
      );
      await write("]");
    }
    for (const [table, { parent, fk }] of Object.entries(TENANT_JOIN_TABLES)) {
      await write(`,\n${JSON.stringify(table)}:[`);
      counts[table] = await streamRows(
        q,
        write,
        `select x.* from "${table}" x join "${parent}" p on p.id = x.${fk} where p.workspace_id = $1 order by x.${fk}, x::text`,
        [wsId],
      );
      await write("]");
    }
    const excluded = Object.fromEntries(
      Object.entries(TENANT_TABLES)
        .filter(([, p]) => !p.export)
        .map(([t, p]) => [t, p.reason ?? ""]),
    );
    await write(
      `},\n"excludedTables":${JSON.stringify(excluded)},\n"attachments":${JSON.stringify({ count: 0, items: [] })},\n"counts":${JSON.stringify(counts)}}\n`,
    );
  });
}

/**
 * Row-level tenancy for the personal export: a row from a workspace is only
 * included while the user is CURRENTLY a member of it and the workspace is not
 * pending deletion. Content they authored or were assigned in a workspace
 * they were removed from belongs to that workspace (titles, descriptions and
 * states can hold another tenant's data), so it is excluded outright rather
 * than redacted to ids: ids alone still confirm which issues existed and
 * who touched them. Expects the user id as $1 and a `workspace_id` column.
 */
const LIVE_MEMBERSHIP = `workspace_id in (
  select m.workspace_id from workspace_members m
    join workspaces w on w.id = m.workspace_id
   where m.user_id = $1 and w.deleted_at is null)`;

/** everything Tallyline holds about one person, as one JSON document */
export async function streamPersonalExport(userId: string, write: Write): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) throw new Error("user not found");
  const head = {
    format: "tallyline-personal-export",
    version: 1,
    exportedAt: clock.now().toISOString(),
    profile: {
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      emailVerifiedAt: u.emailVerifiedAt,
      createdAt: u.createdAt,
      hasPassword: u.passwordHash !== null,
    },
  };
  const sections: [string, string, string[]?][] = [
    [
      "memberships",
      `select m.workspace_id, w.slug as workspace_slug, w.name as workspace_name, m.role, m.created_at
         from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = $1 order by m.created_at`,
    ],
    [
      "signInIdentities",
      `select provider_key, provider_subject, email, email_verified, created_at from auth_identities where user_id = $1 order by created_at`,
    ],
    [
      "sessions",
      `select s.id, w.slug as workspace_slug, s.created_at, s.expires_at
         from sessions s join workspaces w on w.id = s.workspace_id where s.user_id = $1 order by s.created_at`,
    ],
    [
      "personalAccessTokens",
      `select t.id, w.slug as workspace_slug, t.name, t.scopes, t.expires_at, t.last_used_at, t.created_at
         from user_tokens t join workspaces w on w.id = t.workspace_id where t.user_id = $1 order by t.created_at`,
    ],
    [
      "connectedApps",
      `select id, workspace_id, client_name, scopes, revoked_at, last_used_at, created_at from oauth_grants where user_id = $1 order by created_at`,
    ],
    ["views", `select * from views where owner_id = $1 and ${LIVE_MEMBERSHIP} order by created_at`],
    [
      "issuesCreated",
      `select id, workspace_id, key, title, description, state, created_at from issues
        where creator_type = 'human' and creator_id = $1 and ${LIVE_MEMBERSHIP} order by created_at`,
    ],
    [
      "issuesAssigned",
      `select id, workspace_id, key, title, state, created_at from issues
        where assignee_type = 'human' and assignee_id = $1 and ${LIVE_MEMBERSHIP} order by created_at`,
    ],
    [
      "comments",
      `select id, workspace_id, issue_id, body, created_at from comments
        where actor_type = 'human' and actor_id = $1 and ${LIVE_MEMBERSHIP} order by created_at`,
    ],
    [
      "activity",
      `select id, workspace_id, entity_type, entity_id, action, created_at from events
        where actor_type = 'human' and actor_id = $1 and ${LIVE_MEMBERSHIP} order by id`,
    ],
    [
      "securityLog",
      `select id, action, meta, created_at from audit_events where user_id = $1 order by id`,
    ],
  ];
  const headJson = JSON.stringify(head);
  await withSnapshot(async (q) => {
    await write(headJson.slice(0, -1));
    for (const [name, sqlText, red] of sections) {
      await write(`,\n${JSON.stringify(name)}:[`);
      await streamRows(q, write, sqlText, [userId], red);
      await write("]");
    }
    await write("}\n");
  });
}
