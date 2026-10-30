import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { aiProviders, aiUsageLedger, issues } from "../db/schema.js";
import { app } from "../index.js";
import { __setAiFetchForTests, type AiFetch } from "./ai-providers.js";
import { createAssist, MAX_SUB_ISSUES } from "./assist.js";
import { mkIssue, newSession, seedTenant, type Tenant } from "../../test/tenants.js";

// S3-U4: assist runs on the workspace's provider seam (cap + ledger), and the
// break-down action only proposes sub-issues; nothing is written.

let A: Tenant;
let cookie = "";
let key = "";

beforeAll(async () => {
  A = await seedTenant("act-a", "ACT");
  cookie = `tly_session=${await newSession(A, "member")}`;
  key = (await mkIssue(A, { title: "Ship the billing page", description: "plans, invoices, card update" })).key;
});

const reset = async () => {
  await db.delete(aiProviders).where(eq(aiProviders.workspaceId, A.ws.id));
  await db.delete(aiUsageLedger).where(eq(aiUsageLedger.workspaceId, A.ws.id));
};
beforeEach(reset);
afterEach(async () => {
  __setAiFetchForTests(null);
  await reset();
});

// a keyless compatible endpoint: no secrets key needed, no network
async function connect(capCents: number | null = null) {
  await db.insert(aiProviders).values({
    workspaceId: A.ws.id,
    kind: "openai_compatible",
    label: "Stub",
    baseUrl: "https://llm.example.test/v1",
    model: "stub-model",
    apiKeyEnc: null,
    monthlyCapCents: capCents,
  });
}

function model(content: string, status = 200, costUsd = 0.0004) {
  const calls: string[] = [];
  const f: AiFetch = async (url) => {
    calls.push(url);
    return {
      status,
      body: JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 50, completion_tokens: 20, cost: costUsd },
      }),
    };
  };
  __setAiFetchForTests(f);
  return calls;
}

const post = async (path: string, body?: unknown) => {
  const res = await app.fetch(
    new Request(`http://api.test/v1/workspaces/${A.ws.slug}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

describe("assist on the provider seam", () => {
  it("is off with a pointer to Settings > AI when nothing is connected", async () => {
    const r = await post(`/issues/${key}/summarize`);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).toContain("Settings, AI");
  });

  it("summarize calls the workspace provider and writes a ledger row", async () => {
    await connect();
    const calls = model("Billing page work: plans, invoices, card update.");
    const r = await post(`/issues/${key}/summarize`);
    expect(r.status).toBe(200);
    expect(r.body.summary).toContain("Billing page");
    expect(calls).toEqual(["https://llm.example.test/v1/chat/completions"]);
    const rows = await db.select().from(aiUsageLedger).where(eq(aiUsageLedger.workspaceId, A.ws.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "summarize", model: "stub-model", status: "ok", costMicros: 400 });
  });

  it("status reports the workspace provider's model", async () => {
    await connect();
    const res = await app.fetch(
      new Request(`http://api.test/v1/workspaces/${A.ws.slug}/llm/status`, { headers: { cookie } }),
    );
    expect(await res.json()).toEqual({ enabled: true, model: "stub-model", source: "workspace" });
  });

  it("a spent cap pauses actions before any call", async () => {
    await connect(1);
    await db.insert(aiUsageLedger).values({ workspaceId: A.ws.id, action: "summarize", model: "stub-model", costMicros: 20_000 });
    const calls = model("never");
    const r = await post(`/issues/${key}/breakdown-suggest`);
    expect(r.status).toBe(402);
    expect(JSON.stringify(r.body)).toContain("AI_CAP_REACHED");
    expect(calls).toHaveLength(0);
  });

  it("a provider failure is a plain message, not a crash", async () => {
    await connect();
    model("", 500);
    const r = await post(`/issues/${key}/summarize`);
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).toContain("didn't complete the request");
  });
});

describe("break-down into sub-issues", () => {
  it("returns drafts and writes nothing", async () => {
    await connect();
    model(
      JSON.stringify({
        subIssues: [
          { title: "Plans table", description: "list plans with prices" },
          { title: "Invoices list", description: "download PDFs" },
          { title: "plans table", description: "duplicate, dropped" },
          { title: "", description: "no title, dropped" },
        ],
      }),
    );
    const before = await db.select({ id: issues.id }).from(issues).where(eq(issues.workspaceId, A.ws.id));
    const r = await post(`/issues/${key}/breakdown-suggest`);
    expect(r.status).toBe(200);
    expect(r.body.subIssues).toEqual([
      { title: "Plans table", description: "list plans with prices" },
      { title: "Invoices list", description: "download PDFs" },
    ]);
    const after = await db.select({ id: issues.id }).from(issues).where(eq(issues.workspaceId, A.ws.id));
    expect(after).toHaveLength(before.length);
    const [row] = await db
      .select()
      .from(aiUsageLedger)
      .where(and(eq(aiUsageLedger.workspaceId, A.ws.id), eq(aiUsageLedger.action, "breakdown")));
    expect(row).toBeTruthy();
  });

  it("caps the number of drafts and rejects unreadable output", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `Step ${i}`, description: "" }));
    const capped = await createAssist({ complete: async () => JSON.stringify({ subIssues: many }) }).suggestSubIssues(A.ws.id, key);
    expect(capped).toHaveLength(MAX_SUB_ISSUES);
    await expect(
      createAssist({ complete: async () => "sure, here you go" }).suggestSubIssues(A.ws.id, key),
    ).rejects.toMatchObject({ code: "LLM_BAD_RESPONSE" });
  });

  it("is 404 for an issue in another workspace", async () => {
    await connect();
    model("{}");
    const r = await post(`/issues/NOPE-999/breakdown-suggest`);
    expect(r.status).toBe(404);
  });
});
