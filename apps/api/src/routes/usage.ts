import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireRole } from "../services/members.js";
import { usageReport } from "../services/usage.js";
import { requireWorkspace } from "./workspaces.js";

// Settings > Usage (PLAN-059): plan, live counters and the daily rollup.
// Owner/admin only: usage is a billing concern, not a member one.
export const usageRoutes = new Hono().get(
  "/workspaces/:ws/usage",
  zValidator("query", z.object({ days: z.coerce.number().int().min(1).max(90).default(30) })),
  async (c) => {
    const ws = await requireWorkspace(c);
    requireRole(c, "admin");
    const { days } = c.req.valid("query");
    return c.json(await usageReport(ws.id, days));
  },
);
