// Portfolio / client overview read. Visibility is the same as
// GET /workspaces/:ws/projects: any workspace member or read-scope agent key.
import { Hono } from "hono";
import { portfolioForWorkspace } from "../services/portfolio.js";
import { requireWorkspace } from "./workspaces.js";

export const portfolioRoutes = new Hono().get("/workspaces/:ws/portfolio", async (c) => {
  const ws = await requireWorkspace(c);
  return c.json(await portfolioForWorkspace(ws.id));
});
