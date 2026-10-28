import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole } from "../services/members.js";
import {
  complete,
  DEFAULT_MONTHLY_CAP_CENTS,
  MAX_MONTHLY_CAP_CENTS,
  monthSpend,
  recentUsage,
  removeProvider,
  resolveProvider,
  saveProvider,
  viewOf,
} from "../services/ai-providers.js";
import { apiError, HttpError } from "../lib/errors.js";
import { createKeyedLimiter } from "../lib/rate-limit.js";
import { requireWorkspace } from "./workspaces.js";

const putSchema = z.object({
  kind: z.enum(["openrouter", "openai_compatible"]),
  label: z.string().min(1).max(80),
  baseUrl: z.string().max(500).optional(),
  model: z.string().min(1).max(200),
  /** omit to keep the saved key, "" to remove it */
  apiKey: z.string().max(500).optional(),
  monthlyCapCents: z.number().int().min(0).max(MAX_MONTHLY_CAP_CENTS).nullable().optional(),
});

// the test button makes a real (paid) call: keep a stuck script from spamming it
export const aiTestLimiter = createKeyedLimiter(6, 60_000, { prefix: "ai-test" });

// Admin-only. Agent keys never reach these (role check), and no response here
// ever contains the API key: only `hasKey`.
export const aiProviderRoutes = new Hono()
  .get("/workspaces/:ws/ai/provider", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const p = await resolveProvider(ws.id);
    const spend = await monthSpend(ws.id);
    return c.json({
      provider: p ? viewOf(p) : null,
      defaultMonthlyCapCents: DEFAULT_MONTHLY_CAP_CENTS,
      usage: {
        periodStart: spend.periodStart.toISOString(),
        periodEnd: spend.periodEnd.toISOString(),
        spentCents: spend.spentCents,
        calls: spend.calls,
        tokensIn: spend.tokensIn,
        tokensOut: spend.tokensOut,
      },
    });
  })
  .put("/workspaces/:ws/ai/provider", zValidator("json", putSchema), async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const actorId = c.get("session")?.userId;
    if (!actorId) return apiError(c, 403, "FORBIDDEN", "connecting a provider needs a signed-in person");
    const body = c.req.valid("json");
    await saveProvider(ws.id, actorId, body);
    const p = await resolveProvider(ws.id);
    return c.json({ provider: p ? viewOf(p) : null });
  })
  .delete("/workspaces/:ws/ai/provider", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const actorId = c.get("session")?.userId;
    if (!actorId) return apiError(c, 403, "FORBIDDEN", "disconnecting a provider needs a signed-in person");
    const removed = await removeProvider(ws.id, actorId);
    if (!removed) throw new HttpError(404, "NOT_FOUND", "this workspace has no AI provider of its own to disconnect");
    return c.json({ ok: true });
  })
  .post("/workspaces/:ws/ai/provider/test", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const limited = await aiTestLimiter.hit(c, ws.id);
    if (limited) return limited;
    const started = Date.now();
    try {
      const r = await complete(ws.id, "test", {
        user: "Reply with the single word: ok",
        maxTokens: 8,
        temperature: 0,
      });
      return c.json({ ok: true, model: r.model, ms: Date.now() - started });
    } catch (e) {
      // a failing test is an answer, not a server error
      if (e instanceof HttpError) {
        return c.json({ ok: false, code: e.code, message: e.message, ms: Date.now() - started });
      }
      throw e;
    }
  })
  .get("/workspaces/:ws/ai/usage", async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const [spend, recent] = await Promise.all([monthSpend(ws.id), recentUsage(ws.id)]);
    return c.json({
      periodStart: spend.periodStart.toISOString(),
      periodEnd: spend.periodEnd.toISOString(),
      spentCents: spend.spentCents,
      calls: spend.calls,
      recent: recent.map((r) => ({
        action: r.action,
        model: r.model,
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        costCents: Math.round(r.costMicros / 100) / 100,
        status: r.status,
        at: r.createdAt.toISOString(),
      })),
    });
  });
