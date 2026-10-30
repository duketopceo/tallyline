import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { apiError } from "../lib/errors.js";
import { deviceForToken } from "../services/devices.js";
import {
  PUSH_KINDS,
  getPrefs,
  isValidTimeZone,
  pushConfig,
  setDeviceHandle,
  setPrefs,
  type PushKind,
} from "../services/push.js";
import { requireWorkspace } from "./workspaces.js";

// S4-U3. Push is a person's own phone: agents never see these routes, and only
// the paired device itself can hand over its relay handle.

type Ctx = Parameters<typeof apiError>[0];

function patTokenId(c: Ctx): string | null {
  const id = c.get("session")?.sessionId;
  return id?.startsWith("pat:") ? id.slice(4) : null;
}

const handleSchema = z.object({
  handle: z.string().startsWith("h1.").max(1024),
  environment: z.enum(["sandbox", "production"]),
});

const minutes = z.number().int().min(0).max(1439).nullable();
const prefsSchema = z
  .object({
    disabledKinds: z.array(z.enum(PUSH_KINDS as [PushKind, ...PushKind[]])).max(PUSH_KINDS.length),
    quietStart: minutes,
    quietEnd: minutes,
    tz: z.string().min(1).max(64).nullable(),
  })
  .refine((p) => (p.quietStart === null) === (p.quietEnd === null), {
    message: "set both quietStart and quietEnd, or neither",
  })
  .refine((p) => p.quietStart === null || p.tz !== null, { message: "quiet hours need a time zone (tz)" })
  .refine((p) => p.tz === null || isValidTimeZone(p.tz), { message: "unknown time zone" });

export const pushRoutes = new Hono()
  .get("/workspaces/:ws/push/config", async (c) => {
    if (!c.get("session")) return apiError(c, 403, "FORBIDDEN_AGENT", "push is for people's own devices");
    await requireWorkspace(c);
    return c.json(pushConfig());
  })
  .put("/workspaces/:ws/devices/current/push", zValidator("json", handleSchema), async (c) => {
    const tokenId = patTokenId(c);
    const session = c.get("session");
    if (!tokenId || !session) return apiError(c, 403, "FORBIDDEN", "only a paired device can register for push");
    const ws = await requireWorkspace(c);
    const d = await deviceForToken(ws.id, session.userId, tokenId);
    if (!d) return apiError(c, 404, "NOT_A_DEVICE", "this credential isn't a paired device");
    if (!pushConfig().enabled) return apiError(c, 409, "PUSH_OFF", "push isn't set up on this server");
    const b = c.req.valid("json");
    await setDeviceHandle(d.id, b.handle, b.environment);
    return c.json({ ok: true, deviceId: d.id });
  })
  .delete("/workspaces/:ws/devices/current/push", async (c) => {
    const tokenId = patTokenId(c);
    const session = c.get("session");
    if (!tokenId || !session) return apiError(c, 403, "FORBIDDEN", "only a paired device can turn its push off");
    const ws = await requireWorkspace(c);
    const d = await deviceForToken(ws.id, session.userId, tokenId);
    if (!d) return apiError(c, 404, "NOT_A_DEVICE", "this credential isn't a paired device");
    await setDeviceHandle(d.id, null, null);
    return c.json({ ok: true });
  })
  .get("/workspaces/:ws/push/preferences", async (c) => {
    const session = c.get("session");
    if (!session) return apiError(c, 403, "FORBIDDEN_AGENT", "push is for people's own devices");
    const ws = await requireWorkspace(c);
    return c.json(await getPrefs(ws.id, session.userId));
  })
  .put("/workspaces/:ws/push/preferences", zValidator("json", prefsSchema), async (c) => {
    const session = c.get("session");
    if (!session) return apiError(c, 403, "FORBIDDEN_AGENT", "push is for people's own devices");
    const ws = await requireWorkspace(c);
    return c.json(await setPrefs(ws.id, session.userId, c.req.valid("json")));
  });
