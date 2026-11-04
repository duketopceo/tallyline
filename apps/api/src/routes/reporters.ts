import { Hono } from "hono";
import { apiError } from "../lib/errors.js";
import { readReport, unsubscribeReport } from "../services/reporters.js";

// Reporter follow-up (plan 2026-11-03 U3). Public by design: the handle token
// is the only credential, there is no session and no cookie. Mounted BEFORE
// requireSession in index.ts. Unknown and expired tokens answer the same 404
// so the route never confirms that a report exists.
export const reporterPublicRoutes = new Hono()
  .get("/report/:token", async (c) => {
    const view = await readReport(c.req.param("token"));
    if (!view) {
      return apiError(c, 404, "REPORT_NOT_FOUND", "report not found");
    }
    return c.json(view);
  })
  .get("/report/:token/unsubscribe", async (c) => {
    const ok = await unsubscribeReport(c.req.param("token"));
    if (!ok) {
      return apiError(c, 404, "REPORT_NOT_FOUND", "report not found");
    }
    // a plain HTML page: this link is opened from a mail client, not an app
    return c.html(
      "<!doctype html><meta charset=\"utf-8\"><title>Unsubscribed</title><p>You will not receive further email about this report. Your link still works.</p>",
      200,
    );
  });
