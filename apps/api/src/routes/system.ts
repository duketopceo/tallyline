import { Hono } from "hono";
import { requireRole } from "../services/members.js";
import { buildSystemStatus } from "../services/system-status.js";
import { requireWorkspace } from "./workspaces.js";

// Admin-only, read-only. Reports yes/no state and public addresses, never a
// secret, so it is safe to show on a first-run checklist.
export const systemRoutes = new Hono().get("/workspaces/:ws/system/status", async (c) => {
  const ws = await requireWorkspace(c);
  requireRole(c, "admin");
  c.header("Cache-Control", "no-store");
  return c.json(await buildSystemStatus(ws.id));
});
