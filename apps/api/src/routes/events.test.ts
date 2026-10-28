import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.js";
import { closeDb, db } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { getPollCount } from "../services/event-hub.js";
import {
  agentKeys,
  agents,
  authIdentities,
  authProviders,
  comments,
  events,
  invites,
  issues,
  labels,
  oauthCodes,
  sessions,
  slackLinks,
  teamMembers,
  teams,
  userIdMap,
  users,
  workspaceMembers,
  workspaces,
} from "../db/schema.js";

const SLUG = "events-test";
const SLUG2 = `${SLUG}-other`;

interface TestBody {
  error?: { code: string; message: string };
  events?: {
    id: string;
    action: string;
    actorType: string;
    actorName: string | null;
    issueKey: string | null;
    createdAt: string;
  }[];
  nextCursor?: string | null;
  [key: string]: unknown;
}

let sessionCookie = "";

async function req(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: TestBody }> {
  const extraHeaders = (init?.headers as Record<string, string>) ?? {};
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(sessionCookie && !extraHeaders.authorization
          ? { cookie: sessionCookie }
          : {}),
        ...extraHeaders,
      },
    }),
  );
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tly_session=")) {
    sessionCookie = setCookie.split(";")[0]!;
  }
  return { status: res.status, body: (await res.json()) as TestBody };
}

// Raw fetch for the SSE stream — req() would block forever on res.json().
async function raw(
  path: string,
  init?: RequestInit & { cookie?: boolean },
): Promise<Response> {
  const { cookie = true, ...rest } = init ?? {};
  const extraHeaders = (rest.headers as Record<string, string>) ?? {};
  return app.fetch(
    new Request(`http://api.test${path}`, {
      ...rest,
      headers: {
        ...(cookie && sessionCookie && !extraHeaders.authorization
          ? { cookie: sessionCookie }
          : {}),
        ...extraHeaders,
      },
    }),
  );
}

async function readSSEFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 8_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE frame timeout")), timeoutMs),
      ),
    ]);
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    // comment frames (": open" on connect, ": hb" heartbeats) are not events
    for (let end = buf.indexOf("\n\n"); end >= 0; end = buf.indexOf("\n\n")) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      if (!frame.startsWith(":")) return frame;
    }
  }
  throw new Error("no SSE frame received");
}

function frameData(frame: string): Record<string, unknown> {
  const line = frame
    .split("\n")
    .find((l) => l.startsWith("data: "));
  expect(line, "frame carries a data: line").toBeTruthy();
  return JSON.parse(line!.slice(6)) as Record<string, unknown>;
}

beforeAll(async () => {
  await runMigrations();
  // same reason as api.test.ts — bootstrap only works on an empty deployment
  for (const t of [
    comments,
    events,
    issues,
    slackLinks,
    labels,
    agentKeys,
    agents,
    authIdentities,
    authProviders,
    invites,
    oauthCodes,
    teamMembers,
    userIdMap,
    workspaceMembers,
    sessions,
    users,
    teams,
  ] as const) {
    await db.delete(t);
  }
  await db.delete(workspaces);
});

afterAll(async () => {
  for (const slug of [SLUG, SLUG2]) {
    const [ws] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.slug, slug));
    if (ws) {
      await db
        .delete(invites)
        .where(eq(invites.workspaceId, ws.id));
      await db
        .delete(users)
        .where(
          sql`${users.id} in (select ${workspaceMembers.userId} from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${ws.id})`,
        );
      for (const t of [
        comments,
        events,
        issues,
        slackLinks,
        labels,
        agentKeys,
        agents,
        invites,
        oauthCodes,
        workspaceMembers,
        sessions,
        teams,
      ] as const) {
        await db.delete(t).where(eq(t.workspaceId, ws.id));
      }
      await db.delete(workspaces).where(eq(workspaces.id, ws.id));
    }
  }
  await closeDb();
});

describe("workspace events feed + SSE stream", () => {
  let issueKey = "";

  it("bootstraps a workspace and creates an issue", async () => {
    const boot = await req("/v1/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({
        workspaceSlug: SLUG,
        workspaceName: "SSE Test",
        teamKey: "ENG",
        email: "sse@t.co",
        name: "SSE Tester",
        password: "test-password-123",
      }),
    });
    expect(boot.status).toBe(201);

    const created = await req(`/v1/workspaces/${SLUG}/issues`, {
      method: "POST",
      body: JSON.stringify({ teamKey: "ENG", title: "Stream me" }),
    });
    expect(created.status).toBe(201);
    issueKey = created.body.key as string;
    expect(issueKey).toBe("ENG-1");
  });

  it("lists workspace events newest-first with issue + actor joins", async () => {
    const res = await req(`/v1/workspaces/${SLUG}/events`);
    expect(res.status).toBe(200);
    expect(res.body.events!.length).toBeGreaterThan(0);

    const first = res.body.events![0]!;
    expect(first.issueKey).toBe(issueKey);
    expect(first.action).toBe("created");
    expect(first.actorType).toBe("human");
    expect(first.actorName).toBe("SSE Tester");
    expect(typeof first.id).toBe("string");

    // newest-first: ids strictly descending
    const ids = res.body.events!.map((e) => Number(e.id));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    // a second event so limit=1 has a page to hand back
    const comment = await req(
      `/v1/workspaces/${SLUG}/issues/${issueKey}/comments`,
      { method: "POST", body: JSON.stringify({ body: "pagination fodder" }) },
    );
    expect(comment.status).toBe(201);

    // cursor pagination
    const page1 = await req(`/v1/workspaces/${SLUG}/events?limit=1`);
    expect(page1.body.events).toHaveLength(1);
    expect(page1.body.events![0]!.action).toBe("commented");
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await req(
      `/v1/workspaces/${SLUG}/events?limit=1&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.status).toBe(200);
    expect(page2.body.events![0]!.action).toBe("created");
    const bad = await req(
      `/v1/workspaces/${SLUG}/events?cursor=not-a-cursor`,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error!.code).toBe("BAD_CURSOR");
  });

  it("scopes the feed to the workspace", async () => {
    // created directly (not via POST /workspaces, which would make the
    // caller an owner-member) — a non-member workspace must 403 even
    // though roaming cookie sessions exist (U2)
    await db.insert(workspaces).values({ slug: SLUG2, name: "Other WS" });
    const res = await req(`/v1/workspaces/${SLUG2}/events`);
    expect(res.status).toBe(403);
    expect(res.body.error!.code).toBe("FORBIDDEN_WORKSPACE");
  });

  it("rejects unauthenticated stream and list requests", async () => {
    const stream = await app.fetch(
      new Request(`http://api.test/v1/workspaces/${SLUG}/events/stream`),
    );
    expect(stream.status).toBe(401);
    await stream.body?.cancel();

    const list = await app.fetch(
      new Request(`http://api.test/v1/workspaces/${SLUG}/events`),
    );
    expect(list.status).toBe(401);
  });

  it(
    "streams committed events over SSE with Last-Event-ID resume",
    async () => {
      // newest event so far — the stream must only emit ids after it
      const latest = await req(`/v1/workspaces/${SLUG}/events?limit=1`);
      const lastId = latest.body.events![0]!.id;

      const res = await raw(`/v1/workspaces/${SLUG}/events/stream`, {
        headers: { "last-event-id": lastId },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      try {
        // a commit in "another client" after the stream opened
        const comment = await req(
          `/v1/workspaces/${SLUG}/issues/${issueKey}/comments`,
          {
            method: "POST",
            body: JSON.stringify({ body: "hello over SSE" }),
          },
        );
        expect(comment.status).toBe(201);

        const frame = await readSSEFrame(reader);
        const evt = frameData(frame);
        expect(evt.action).toBe("commented");
        expect(evt.issueKey).toBe(issueKey);
        expect(evt.actorName).toBe("SSE Tester");
        expect(frame).toContain(`id: ${evt.id}`);
        expect(Number(evt.id)).toBeGreaterThan(Number(lastId));
      } finally {
        await reader.cancel();
      }
    },
    15_000,
  );

  it("supports ?after= resume and rejects bad cursors", async () => {
    const bad = await raw(`/v1/workspaces/${SLUG}/events/stream?after=abc`);
    expect(bad.status).toBe(400);
    await bad.body?.cancel();

    const res = await raw(`/v1/workspaces/${SLUG}/events/stream?after=0`);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      // after=0 replays history — first frame is the oldest event
      const frame = await readSSEFrame(reader);
      const evt = frameData(frame);
      expect(evt.action).toBe("created");
      expect(evt.issueKey).toBe(issueKey);
    } finally {
      await reader.cancel();
    }
  });

  it(
    "fans one event out to N connections on a single shared poller",
    async () => {
      // newest event so far — each stream resumes after it
      const latest = await req(`/v1/workspaces/${SLUG}/events?limit=1`);
      const lastId = latest.body.events![0]!.id;

      const open = () =>
        raw(`/v1/workspaces/${SLUG}/events/stream`, {
          headers: { "last-event-id": lastId },
        });
      const [s1, s2, s3] = await Promise.all([open(), open(), open()]);
      const readers = [s1, s2, s3].map((r) => {
        expect(r.status).toBe(200);
        return r.body!.getReader();
      });

      try {
        const pollsBefore = getPollCount();

        const comment = await req(
          `/v1/workspaces/${SLUG}/issues/${issueKey}/comments`,
          { method: "POST", body: JSON.stringify({ body: "fan-out" }) },
        );
        expect(comment.status).toBe(201);

        // all three connections receive the same event
        for (const reader of readers) {
          const evt = frameData(await readSSEFrame(reader));
          expect(evt.action).toBe("commented");
          expect(evt.issueKey).toBe(issueKey);
        }

        // three connections for ~1 poll window must not triple the poll rate:
        // the whole point is ≤1 query/sec process-wide
        await new Promise((r) => setTimeout(r, 1_600));
        expect(getPollCount() - pollsBefore).toBeLessThanOrEqual(3);
      } finally {
        for (const reader of readers) await reader.cancel();
      }
    },
    20_000,
  );

  it("lets a read-scoped agent key open the stream", async () => {
    const agent = await req(`/v1/workspaces/${SLUG}/agents`, {
      method: "POST",
      body: JSON.stringify({ name: "sse-bot", harness: "test" }),
    });
    expect(agent.status).toBe(201);

    const key = await req(
      `/v1/workspaces/${SLUG}/agents/${agent.body.id}/keys`,
      { method: "POST", body: JSON.stringify({ name: "ro", scopes: ["read"] }) },
    );
    expect(key.status).toBe(201);

    const res = await raw(`/v1/workspaces/${SLUG}/events/stream`, {
      cookie: false,
      headers: { authorization: `Bearer ${key.body.key}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body!.getReader().cancel();
  });
});
