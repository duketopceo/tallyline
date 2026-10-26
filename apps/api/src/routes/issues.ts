import { Hono } from "hono";
import { commentRoutes } from "./issues/comments.js";
import { coreIssueRoutes } from "./issues/core.js";
import { labelRoutes } from "./issues/labels.js";
import { relationRoutes } from "./issues/relations.js";
import { slackLinkRoutes } from "./issues/slack-link.js";
import { suggestionRoutes } from "./issues/suggestions.js";
import { workflowRoutes } from "./issues/workflow.js";

// The issues surface, mounted in original registration order — sub-routers
// live under ./issues/ by capability: core CRUD, comments/events, workflow
// (triage + review), workspace labels, and Slack thread linkage.
export const issueRoutes = new Hono()
  .route("/", coreIssueRoutes)
  .route("/", commentRoutes)
  .route("/", workflowRoutes)
  .route("/", labelRoutes)
  .route("/", slackLinkRoutes)
  .route("/", suggestionRoutes)
  .route("/", relationRoutes);
