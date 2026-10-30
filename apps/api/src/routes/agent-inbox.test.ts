import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { agentActivities } from "../db/schema.js";
import { app } from "../index.js";
import { createAgentKey } from "../services/agents.js";
import {
  mkAgent,
  mkAgentSession,
  mkDispatch,
  mkIssue,
  newSession,
  seedTenant,
  type Tenant,
} from "../../test/tenants.js";

// U20 (R18): mentions and answered questions reach the calling agent's inbox,
// an ack hides them, and one agent never sees another's.

let A: Tenant;
let B: Tenant;
let cookie: string;
let agentKey: string;
let otherKey: string;
let otherAgentId: string;

beforeAll(async () => {
  A = await seedTenant("ib-a", "IBA");
  B = await seedTenant("ib-b", "IBB");
  cookie = `tly_session=${await newSession(A, "member")}`;
  agentKey = A.agentKeys.write;
  const other = await mkAgent(A);
  otherAgentId = other.id;
  otherKey = (await createAgentKey(other.id, A.ws.id, "other", ["read", "write"])).key;
});

interface InboxBody {
  [k: string]: unknown;
  items: { kind: string; id: string; issueKey: string; excerpt: string; createdAt: string }[];
  ackedAt: string | null;
}

async function call(path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) {
  const { cookie: ck, bearer, ...rest } = init;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(ck ? { cookie: ck } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
    }),
  );
  return { status: res.status, body: (await res.json()) as InboxBody };
}

const ws = (t: Tenant) => `/v1/workspaces/${t.ws.slug}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mention(issueKey: string, agentName: string, text: string) {
  const r = await call(`${ws(A)}/issues/${issueKey}/comments`, {
    method: "POST",
    cookie,
    body: JSON.stringify({ body: `@${agentName} ${text}` }),
  });
  expect(r.status).toBe(201);
}

async function humanPrompt(sessionId: string, body: string) {
  await db.insert(agentActivities).values({
    sessionId,
    workspaceId: A.ws.id,
    type: "prompt",
    content: { type: "prompt", body },
    actorType: "human",
    actorId: A.people.member.id,
  });
}

describe("agent inbox (real postgres)", () => {
  it("lists a mention once and an ack clears it", async () => {
    const issue = await mkIssue(A);
    await mention(issue.key, A.agent.name, "please look at this");
    const first = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(first.status).toBe(200);
    const items = first.body.items.filter((i) => i.issueKey === issue.key);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("mention");
    expect(items[0]!.excerpt).toContain("please look at this");

    const last = first.body.items.at(-1)!;
    const ack = await call(`${ws(A)}/agent-inbox/ack`, {
      method: "POST",
      bearer: agentKey,
      body: JSON.stringify({ through: last.createdAt }),
    });
    expect(ack.status).toBe(200);
    const after = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(after.body.items.filter((i) => i.issueKey === issue.key)).toHaveLength(0);

    await sleep(15);
    await mention(issue.key, A.agent.name, "second ask");
    const later = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(later.body.items.filter((i) => i.issueKey === issue.key).map((i) => i.excerpt.includes("second ask"))).toEqual([true]);
  });

  it("lists a human reply on the agent's session as an answered question", async () => {
    const issue = await mkIssue(A);
    const dispatch = await mkDispatch(A, issue.id);
    const session = await mkAgentSession(A, dispatch.id, issue.id);
    await humanPrompt(session.id, "use the staging key");
    const res = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    const mine = res.body.items.filter((i) => i.issueKey === issue.key);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("answer");
    expect(mine[0]!.excerpt).toBe("use the staging key");
    // the agent's own activity is not an answer
    await db.insert(agentActivities).values({
      sessionId: session.id,
      workspaceId: A.ws.id,
      type: "prompt",
      content: { type: "prompt", body: "self talk" },
      actorType: "agent",
      actorId: A.agent.id,
    });
    const again = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(again.body.items.filter((i) => i.issueKey === issue.key)).toHaveLength(1);
    // acknowledging the answer clears it
    const ack = await call(`${ws(A)}/agent-inbox/ack`, {
      method: "POST",
      bearer: agentKey,
      body: JSON.stringify({ through: mine[0]!.createdAt }),
    });
    expect(ack.status).toBe(200);
    const afterAck = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(afterAck.body.items.filter((i) => i.issueKey === issue.key)).toHaveLength(0);
  });

  it("never moves the ack mark backwards or past now", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const a = await call(`${ws(A)}/agent-inbox/ack`, { method: "POST", bearer: otherKey, body: JSON.stringify({ through: t1 }) });
    const b = await call(`${ws(A)}/agent-inbox/ack`, { method: "POST", bearer: otherKey, body: JSON.stringify({ through: "2025-01-01T00:00:00.000Z" }) });
    expect(b.body.ackedAt).toBe(a.body.ackedAt);
    const future = await call(`${ws(A)}/agent-inbox/ack`, { method: "POST", bearer: otherKey, body: JSON.stringify({ through: "2999-01-01T00:00:00.000Z" }) });
    expect(Date.parse(future.body.ackedAt as string)).toBeLessThanOrEqual(Date.now());
  });

  it("keeps one agent's inbox private from another's", async () => {
    const issue = await mkIssue(A);
    await mention(issue.key, A.agent.name, "only for the first agent");
    const dispatch = await mkDispatch(A, issue.id);
    const session = await mkAgentSession(A, dispatch.id, issue.id);
    await humanPrompt(session.id, "only for the first agent");
    const other = await call(`${ws(A)}/agent-inbox`, { bearer: otherKey });
    expect(other.status).toBe(200);
    expect(other.body.items.filter((i) => i.issueKey === issue.key)).toHaveLength(0);
    // the owner does see both kinds
    const owner = await call(`${ws(A)}/agent-inbox`, { bearer: agentKey });
    expect(owner.body.items.filter((i) => i.issueKey === issue.key).map((i) => i.kind).sort()).toEqual(["answer", "mention"]);
    expect(otherAgentId).not.toBe(A.agent.id);
  });

  it("refuses human credentials and other workspaces' agents", async () => {
    expect((await call(`${ws(A)}/agent-inbox`, { cookie })).status).toBe(403);
    expect((await call(`${ws(A)}/agent-inbox/ack`, { method: "POST", cookie, body: JSON.stringify({ through: "2026-01-01T00:00:00.000Z" }) })).status).toBe(403);
    expect((await call(`${ws(A)}/agent-inbox`, { bearer: B.agentKeys.read })).status).toBe(403);
  });

  it("rejects a malformed ack time", async () => {
    const r = await call(`${ws(A)}/agent-inbox/ack`, { method: "POST", bearer: agentKey, body: JSON.stringify({ through: "yesterday" }) });
    expect(r.status).toBe(400);
  });
});
