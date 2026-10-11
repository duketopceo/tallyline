// OpenAPI path items for the operations added after the first spec pass
// (auth, dispatch/review, github, import, webhook endpoints, public webhooks).
// Merged into the served document by openapi.ts; the route-diff test fails if
// any registered route is missing from the merged result.

type PathItem = Record<string, unknown>;

const wsParam = {
  name: "ws",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;
const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;
const keyParam = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Z][A-Z0-9]*-\\d+$" },
} as const;

const jsonBody = (schema: Record<string, unknown>) => ({
  required: true,
  content: { "application/json": { schema } },
});

const repoBody = jsonBody({
  type: "object",
  required: ["fullName"],
  properties: {
    fullName: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    teamKey: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" },
  },
});

const importTarget = { type: "string", enum: ["triage", "backlog"], default: "triage" };

export const extraPaths: Record<string, PathItem> = {
  // ── account lifecycle ──────────────────────────────────────────────────────
  "/v1/auth/password/forgot": {
    post: {
      summary:
        "Request a password reset link. Always 202 with the same body (no account enumeration); the link is single-use and expires in 30 minutes. Rate limited.",
      requestBody: jsonBody({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }),
      responses: { "202": { description: "Accepted (whether or not the address has an account)" }, "429": { description: "Rate limited" } },
    },
  },
  "/v1/auth/password/reset": {
    post: {
      summary:
        "Set a new password with a reset token. Revokes every session of the account; personal access tokens are kept. Rate limited.",
      requestBody: jsonBody({
        type: "object",
        required: ["token", "password"],
        properties: { token: { type: "string" }, password: { type: "string", minLength: 10 } },
      }),
      responses: { "200": { description: "Password changed" }, "400": { description: "RESET_TOKEN_INVALID" } },
    },
  },
  "/v1/auth/verify-email": {
    post: {
      summary: "Confirm the account email with a verification token (single-use, 24h). Rate limited.",
      requestBody: jsonBody({ type: "object", required: ["token"], properties: { token: { type: "string" } } }),
      responses: { "200": { description: "Email verified" }, "400": { description: "VERIFY_TOKEN_INVALID" } },
    },
  },
  "/v1/me/verify-email/resend": {
    post: {
      summary: "Send a new email verification link (cookie session only)",
      responses: { "202": { description: "Sent" }, "200": { description: "Already verified" } },
    },
  },
  "/v1/me/export": {
    get: {
      summary: "Download everything Tallyline holds about you as one JSON document, streamed (cookie session only)",
      responses: { "200": { description: "tallyline-personal-export JSON" } },
    },
  },
  "/v1/me/deletion": {
    post: {
      summary:
        "Delete your account (cookie session only). Body confirm must equal your email. Refused with 409 SOLE_OWNER while you are the only owner of a live workspace.",
      requestBody: jsonBody({ type: "object", required: ["confirm"], properties: { confirm: { type: "string" } } }),
      responses: {
        "200": { description: "Account deleted, session cookie cleared" },
        "400": { description: "CONFIRM_MISMATCH" },
        "409": { description: "SOLE_OWNER" },
      },
    },
  },
  "/v1/dev/mail": {
    get: {
      summary:
        "Dev inbox: messages captured by the log mail transport (instance admins, cookie session). Always 404 (even for admins) in production or with a real transport.",
      responses: { "200": { description: "Captured messages, newest first" }, "404": { description: "DEV_INBOX_DISABLED" } },
    },
  },
  "/v1/workspaces/{ws}/export": {
    get: {
      summary:
        "Export the workspace as one streamed JSON document: every tenant table (credentials redacted) plus an attachments manifest (admin+, cookie session only). Available during the restore window.",
      parameters: [wsParam],
      responses: { "200": { description: "tallyline-workspace-export JSON" } },
    },
  },
  "/v1/workspaces/{ws}/deletion": {
    post: {
      summary:
        "Schedule workspace deletion (owner, cookie session only). Body confirm must equal the slug. The workspace closes immediately (410 on other routes) and is hard deleted after the restore window (7 days).",
      parameters: [wsParam],
      requestBody: jsonBody({ type: "object", required: ["confirm"], properties: { confirm: { type: "string" } } }),
      responses: {
        "202": { description: "Scheduled; returns purgeAfter" },
        "400": { description: "CONFIRM_MISMATCH" },
        "409": { description: "ALREADY_SCHEDULED" },
      },
    },
  },
  "/v1/workspaces/{ws}/restore": {
    post: {
      summary: "Restore a workspace scheduled for deletion, inside the restore window (owner, cookie session only)",
      parameters: [wsParam],
      responses: { "200": { description: "Restored" }, "409": { description: "NOT_DELETED" } },
    },
  },
  "/openapi.json": {
    get: {
      summary: "This OpenAPI document",
      responses: { "200": { description: "OpenAPI 3.1 document" } },
    },
  },
  "/webhooks/github": {
    post: {
      summary:
        "GitHub App webhook receiver — HMAC-verified (X-Hub-Signature-256), deduped on X-GitHub-Delivery; unauthenticated by session",
      responses: {
        "200": { description: "Accepted (or duplicate delivery dropped)" },
        "400": { description: "Missing delivery headers or invalid JSON" },
        "401": { description: "Bad signature" },
        "503": { description: "GITHUB_WEBHOOK_SECRET not configured" },
      },
    },
  },
  "/webhooks/slack": {
    post: {
      summary:
        "Slack slash-command / interactivity / events receiver — signature-verified; unauthenticated by session",
      responses: {
        "200": { description: "Handled" },
        "401": { description: "Bad signature" },
        "503": { description: "Slack not configured" },
      },
    },
  },
  "/v1/auth/bootstrap": {
    post: {
      summary:
        "First-run: create the initial workspace, team and owner (only while the instance has no users)",
      requestBody: jsonBody({
        type: "object",
        required: ["workspaceSlug", "workspaceName", "email", "name", "password"],
        properties: {
          workspaceSlug: { type: "string", pattern: "^[a-z0-9-]+$" },
          workspaceName: { type: "string" },
          teamKey: { type: "string", default: "DOK" },
          email: { type: "string", format: "email" },
          name: { type: "string" },
          password: { type: "string", minLength: 10 },
        },
      }),
      responses: {
        "201": { description: "Bootstrapped; session cookie set" },
        "403": { description: "Password auth disabled" },
        "409": { description: "Instance already bootstrapped" },
      },
    },
  },
  "/v1/auth/login": {
    post: {
      summary: "Email + password login; sets the session cookie",
      requestBody: jsonBody({
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
        },
      }),
      responses: {
        "200": { description: "Logged in" },
        "401": { description: "Bad credentials" },
        "403": { description: "Password auth disabled" },
      },
    },
  },
  "/v1/auth/logout": {
    post: {
      summary: "Destroy the current cookie session",
      responses: { "200": { description: "Logged out" } },
    },
  },
  "/v1/auth/me": {
    get: {
      summary: "Current user, active workspace and memberships (cookie session)",
      responses: {
        "200": { description: "Session identity" },
        "401": { description: "No or expired session" },
      },
    },
  },
  "/v1/auth/session": {
    post: {
      summary:
        "Re-bind a cookie session's active workspace (workspace picker); cookie sessions only",
      requestBody: jsonBody({
        type: "object",
        required: ["workspaceSlug"],
        properties: { workspaceSlug: { type: "string" } },
      }),
      responses: {
        "200": { description: "Rebound; returns memberships" },
        "403": { description: "Not a member / not a cookie session" },
        "404": { description: "Workspace not found" },
      },
    },
  },
  "/v1/workspaces/{ws}": {
    get: {
      summary: "Get workspace",
      parameters: [wsParam],
      responses: {
        "200": { description: "Workspace" },
        "404": { description: "Not found or not a member" },
      },
    },
  },
  "/v1/workspaces/{ws}/issues/{key}/review": {
    post: {
      summary:
        "Review an in_review issue — approve (moves to done) or send_back (re-dispatches with feedback). Human members only; agent credentials get 403 FORBIDDEN_AGENT",
      parameters: [wsParam, keyParam],
      requestBody: jsonBody({
        type: "object",
        required: ["action"],
        properties: {
          action: { type: "string", enum: ["approve", "send_back"] },
          feedback: { type: "string", maxLength: 5000 },
        },
      }),
      responses: {
        "200": { description: "Review recorded" },
        "403": { description: "Agent credential (FORBIDDEN_AGENT)" },
        "409": { description: "Issue is not in_review" },
      },
    },
  },
  "/v1/workspaces/{ws}/issues/{key}/sessions": {
    get: {
      summary: "Agent session runs (dispatches) for an issue, each with its event log",
      parameters: [wsParam, keyParam],
      responses: { "200": { description: "Sessions" }, "404": { description: "Issue not found" } },
    },
  },
  "/v1/workspaces/{ws}/dispatches": {
    get: {
      summary: "List dispatches — agent keys only see their own",
      parameters: [
        wsParam,
        {
          name: "status",
          in: "query",
          schema: {
            type: "string",
            enum: ["queued", "claimed", "dispatch_failed", "completed", "canceled"],
          },
        },
        { name: "agentId", in: "query", schema: { type: "string", format: "uuid" } },
      ],
      responses: { "200": { description: "Dispatches" } },
    },
  },
  "/v1/workspaces/{ws}/review-queue": {
    get: {
      summary: "Issues waiting in in_review, grouped with their latest agent run",
      parameters: [wsParam],
      responses: { "200": { description: "Review queue" } },
    },
  },
  "/v1/workspaces/{ws}/review-queue/count": {
    get: {
      summary: "Count of in_review issues that carry at least one dispatch (nav badge)",
      parameters: [wsParam],
      responses: { "200": { description: "Queue depth" } },
    },
  },
  "/v1/workspaces/{ws}/dispatches/{id}/report": {
    post: {
      summary: "Agent session lifecycle report (completed / failed, optional branch + PR URL)",
      parameters: [wsParam, idParam],
      requestBody: jsonBody({
        type: "object",
        required: ["outcome"],
        properties: {
          outcome: { type: "string", enum: ["completed", "failed"] },
          reason: { type: "string", maxLength: 500 },
          branch: { type: "string", maxLength: 200 },
          prUrl: { type: "string", format: "uri" },
        },
      }),
      responses: {
        "200": { description: "Report recorded" },
        "403": { description: "Agent key reporting another agent's dispatch" },
        "404": { description: "Dispatch not found" },
      },
    },
  },
  "/v1/workspaces/{ws}/dispatches/{id}/events": {
    get: {
      summary: "Session event log for a dispatch",
      parameters: [wsParam, idParam],
      responses: {
        "200": { description: "Events" },
        "403": { description: "Agent key reading another agent's dispatch" },
        "404": { description: "Dispatch not found" },
      },
    },
    post: {
      summary: "Append session events (1-50) to a dispatch's log",
      parameters: [wsParam, idParam],
      requestBody: jsonBody({
        type: "object",
        required: ["events"],
        properties: {
          events: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            items: {
              type: "object",
              required: ["kind", "message"],
              properties: {
                kind: { type: "string" },
                message: { type: "string", maxLength: 500 },
              },
            },
          },
        },
      }),
      responses: {
        "201": { description: "Events appended" },
        "403": { description: "Agent key writing another agent's dispatch" },
        "404": { description: "Dispatch not found" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/manifest": {
    get: {
      summary:
        "GitHub App manifest (POST it to github.com/settings/apps/new); redirect_url points at the web callback",
      parameters: [wsParam],
      responses: { "200": { description: "App manifest JSON" } },
    },
  },
  "/github/manifest/callback/{state}": {
    get: {
      summary:
        "Public redirect target of the GitHub App manifest flow (the manifest's redirect_url). Exchanges ?code for the new App's credentials and shows them once; nothing is stored. Send Accept: application/json for JSON.",
      parameters: [
        {
          name: "state",
          in: "path",
          required: true,
          schema: { type: "string" },
          description: "Signed, 10-minute workspace-bound token from the manifest",
        },
        { name: "code", in: "query", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": { description: "Credentials page (HTML) or JSON; Cache-Control: no-store" },
        "400": { description: "Invalid/expired state or code" },
        "502": { description: "GitHub rejected the conversion" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/install-url": {
    get: {
      summary: "URL to install the configured GitHub App",
      parameters: [wsParam],
      responses: {
        "200": { description: "installUrl" },
        "503": { description: "GITHUB_APP_SLUG not set" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/setup": {
    post: {
      summary:
        "Bind a GitHub App installation to this workspace (owner/admin only; verifies the App owns installationId; 409 if bound elsewhere). Called by the web Setup-URL page, not by GitHub directly",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["installationId"],
        properties: { installationId: { type: "integer", minimum: 1 } },
      }),
      responses: {
        "200": { description: "Bound" },
        "400": { description: "Malformed body" },
        "403": { description: "Not an owner/admin (human credential required)" },
        "404": { description: "Installation does not belong to this GitHub App" },
        "409": { description: "Installation already bound to another workspace" },
        "503": { description: "GitHub App credentials not configured" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/repos": {
    get: {
      summary: "Linked GitHub repos",
      parameters: [wsParam],
      responses: { "200": { description: "Repos" } },
    },
  },
  "/v1/workspaces/{ws}/github/repos/connect": {
    post: {
      summary: "Enable sync for a repo (optionally pinned to a team)",
      parameters: [wsParam],
      requestBody: repoBody,
      responses: { "200": { description: "Repo link" }, "404": { description: "Team not found" } },
    },
  },
  "/v1/workspaces/{ws}/github/repos/project": {
    post: {
      summary: "Bind a repo to a project (or null to unbind); synced issues land in the project. Owner/admin",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["fullName", "projectId"],
        properties: {
          fullName: { type: "string", pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
          projectId: { type: ["string", "null"], format: "uuid" },
        },
      }),
      responses: {
        "200": { description: "Repo link" },
        "404": { description: "Repo not linked" },
        "422": { description: "Project not in workspace" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/repos/backfill": {
    post: {
      summary: "Dry-run (default) or apply a repo-to-project map over synced issues with no project. Never moves an issue already in a project. Owner/admin",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        properties: {
          map: { type: "object", additionalProperties: { type: "string", format: "uuid" } },
          apply: { type: "boolean", default: false },
        },
      }),
      responses: {
        "200": { description: "Per-repo plan, unmapped repos and totals" },
        "404": { description: "Repo not linked" },
        "422": { description: "Project not in workspace" },
      },
    },
  },
  "/v1/workspaces/{ws}/github/repos/disconnect": {
    post: {
      summary: "Disable sync for a repo",
      parameters: [wsParam],
      requestBody: repoBody,
      responses: { "200": { description: "Repo link" }, "404": { description: "Repo not linked" } },
    },
  },
  "/v1/workspaces/{ws}/issues/bulk": {
    post: {
      summary: "Set the project and/or add labels on up to 200 issues. All-or-nothing. Owner/admin",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["ids"],
        properties: {
          ids: { type: "array", items: { type: "string", format: "uuid" }, minItems: 1, maxItems: 200 },
          projectId: { type: ["string", "null"], format: "uuid" },
          addLabelIds: { type: "array", items: { type: "string", format: "uuid" }, maxItems: 10 },
        },
      }),
      responses: {
        "200": { description: "Number updated" },
        "404": { description: "An issue is not in the workspace" },
        "422": { description: "Invalid project or labels" },
      },
    },
  },
  "/v1/workspaces/{ws}/import/github": {
    post: {
      summary: "One-shot import of a repo's issues using a caller-supplied token",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["fullName", "token"],
        properties: {
          fullName: { type: "string" },
          token: { type: "string" },
          target: importTarget,
          teamKey: { type: "string" },
        },
      }),
      responses: {
        "200": { description: "Import result (created/skipped/errors)" },
        "404": { description: "Team not found" },
        "502": { description: "GitHub import failed" },
      },
    },
  },
  "/v1/workspaces/{ws}/import/linear": {
    post: {
      summary: "Import a Linear CSV export into a team",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["teamKey", "csv"],
        properties: {
          teamKey: { type: "string" },
          target: importTarget,
          csv: { type: "string" },
        },
      }),
      responses: { "200": { description: "Import result" }, "404": { description: "Team not found" } },
    },
  },
  "/v1/workspaces/{ws}/import/plan": {
    post: {
      summary:
        "Import a ce-plan markdown file into a project as issues. Dry run by default; apply needs the diffHash of a reviewed dry run (409 STALE_DIFF with the new diff if anything changed). Units are titled [SCOPE-U<N>]. done/in_progress evidence and `historical` need a human owner or admin credential (403 FORBIDDEN_HISTORICAL).",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["project", "plan"],
        properties: {
          project: { type: "string", description: "project id or exact name" },
          teamKey: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" },
          plan: {
            type: "object",
            required: ["scope", "source", "markdown"],
            properties: {
              scope: { type: "string", pattern: "^[A-Z][A-Z0-9]{0,7}$" },
              source: {
                type: "object",
                required: ["repo", "path", "sha"],
                properties: {
                  repo: { type: "string" },
                  path: { type: "string" },
                  sha: { type: "string" },
                  url: { type: "string" },
                },
              },
              markdown: { type: "string" },
            },
          },
          evidence: {
            type: "object",
            description: "unit id (U12) to { state, prs, mergedAt }",
            additionalProperties: {
              type: "object",
              properties: {
                state: { type: "string", enum: ["backlog", "todo", "in_progress", "done"] },
                prs: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["repo", "number"],
                    properties: { repo: { type: "string" }, number: { type: "integer" }, url: { type: "string" } },
                  },
                },
                mergedAt: { type: "string", format: "date-time" },
              },
            },
          },
          historical: { type: "boolean", default: false },
          resolutions: {
            type: "object",
            description: "scoped unit id (KP-U12) to an existing issue key, or \"new\" to create the unit, for ambiguous matches",
            additionalProperties: { type: "string" },
          },
          mode: { type: "string", enum: ["dry_run", "apply"], default: "dry_run" },
          diffHash: { type: "string", description: "from a reviewed dry run; required for apply" },
        },
      }),
      responses: {
        "200": { description: "Diff: counts, per-unit action (create, update, unchanged, ambiguous, invalid), milestones, warnings, diffHash" },
        "400": { description: "Invalid body (https urls only, at most 200 evidence and resolution entries), or apply without diffHash (DIFF_HASH_REQUIRED)" },
        "413": { description: "Body over 2MB" },
        "403": { description: "Historical state from a non-owner/admin or agent credential" },
        "404": { description: "Project or team not found" },
        "409": { description: "STALE_DIFF: the diff changed since the dry run; body carries the new diff" },
        "422": { description: "NO_UNITS, PLAN_TOO_LARGE, UNKNOWN_RESOLUTION, DUPLICATE_MATCH or INVALID_EVIDENCE" },
      },
    },
  },
  "/v1/workspaces/{ws}/webhook-endpoints": {
    get: {
      summary: "List outbound webhook endpoints (owner/admin only; secrets masked to last 4)",
      parameters: [wsParam],
      responses: { "200": { description: "Endpoints" } },
    },
    post: {
      summary: "Create an outbound webhook endpoint (owner/admin only); the signing secret is returned once",
      parameters: [wsParam],
      requestBody: jsonBody({
        type: "object",
        required: ["url"],
        properties: {
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" }, default: ["*"] },
          secret: { type: "string", minLength: 16, maxLength: 128 },
        },
      }),
      responses: { "201": { description: "Endpoint created (includes secret)" } },
    },
  },
  "/v1/workspaces/{ws}/webhook-endpoints/{id}": {
    patch: {
      summary: "Update an endpoint (owner/admin only)",
      parameters: [wsParam, idParam],
      requestBody: jsonBody({
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          events: { type: "array", items: { type: "string" } },
          enabled: { type: "boolean" },
        },
      }),
      responses: { "200": { description: "Endpoint" }, "404": { description: "Not found" } },
    },
    delete: {
      summary: "Delete an endpoint (owner/admin only)",
      parameters: [wsParam, idParam],
      responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } },
    },
  },
  "/v1/workspaces/{ws}/webhook-endpoints/{id}/deliveries": {
    get: {
      summary: "Last 50 delivery attempts for an endpoint",
      parameters: [wsParam, idParam],
      responses: { "200": { description: "Deliveries" } },
    },
  },
  "/.well-known/oauth-protected-resource": {
    get: {
      summary: "RFC 9728 protected resource metadata for the MCP endpoint (root form)",
      responses: { "200": { description: "resource, authorization_servers, scopes_supported" } },
    },
  },
  "/.well-known/oauth-protected-resource/mcp": {
    get: {
      summary: "RFC 9728 protected resource metadata for https://<api>/mcp (path-suffixed form)",
      responses: { "200": { description: "resource, authorization_servers, scopes_supported" } },
    },
  },
  "/.well-known/oauth-authorization-server": {
    get: {
      summary:
        "RFC 8414 authorization server metadata: S256 PKCE, CIMD + DCR, RFC 9207 iss, public clients",
      responses: { "200": { description: "Authorization server metadata" } },
    },
  },
  "/oauth/authorize": {
    get: {
      summary:
        "OAuth 2.1 authorization endpoint (code + PKCE S256 + resource indicator). Validates client_id (registered or Client ID Metadata Document URL), exact-match redirect_uri, then redirects the browser to the web consent page",
      parameters: [
        { name: "response_type", in: "query", required: true, schema: { type: "string", enum: ["code"] } },
        { name: "client_id", in: "query", required: true, schema: { type: "string" } },
        { name: "redirect_uri", in: "query", schema: { type: "string" } },
        { name: "code_challenge", in: "query", required: true, schema: { type: "string" } },
        { name: "code_challenge_method", in: "query", required: true, schema: { type: "string", enum: ["S256"] } },
        { name: "resource", in: "query", schema: { type: "string", format: "uri" } },
        { name: "scope", in: "query", schema: { type: "string", example: "read write" } },
        { name: "state", in: "query", schema: { type: "string" } },
      ],
      responses: {
        "302": { description: "Redirect to the consent page (or to the client redirect_uri with an OAuth error and iss)" },
        "400": { description: "Unknown client or unregistered redirect_uri (never redirected)" },
      },
    },
  },
  "/oauth/token": {
    post: {
      summary:
        "OAuth token endpoint (form-encoded): authorization_code + code_verifier, or refresh_token with single-use rotation. Tokens are audience-bound to the MCP resource",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["grant_type", "client_id"],
              properties: {
                grant_type: { type: "string", enum: ["authorization_code", "refresh_token"] },
                client_id: { type: "string" },
                code: { type: "string" },
                redirect_uri: { type: "string" },
                code_verifier: { type: "string" },
                refresh_token: { type: "string" },
                resource: { type: "string", format: "uri" },
                scope: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": { description: "access_token, refresh_token, expires_in, scope" },
        "400": { description: "invalid_request / invalid_grant / invalid_target / invalid_scope" },
        "401": { description: "invalid_client" },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/oauth/register": {
    post: {
      summary: "RFC 7591 dynamic client registration (public clients, token_endpoint_auth_method none)",
      requestBody: jsonBody({
        type: "object",
        required: ["redirect_uris"],
        properties: {
          client_name: { type: "string", maxLength: 100 },
          redirect_uris: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          grant_types: { type: "array", items: { type: "string" } },
          response_types: { type: "array", items: { type: "string" } },
          token_endpoint_auth_method: { type: "string", enum: ["none"] },
        },
      }),
      responses: {
        "201": { description: "Registered client (client_id)" },
        "400": { description: "invalid_client_metadata" },
        "429": { description: "Rate limited" },
      },
    },
  },
  "/oauth/revoke": {
    post: {
      summary: "RFC 7009 token revocation (a refresh token revokes the whole grant); always 200",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" }, client_id: { type: "string" } },
            },
          },
        },
      },
      responses: { "200": { description: "Revoked (or unknown token)" } },
    },
  },
  "/mcp": {
    post: {
      summary:
        "Remote MCP endpoint (Streamable HTTP, stateless, JSON responses). Requires an OAuth access token issued by this server for this resource; the tool surface is apps/mcp-server",
      responses: {
        "200": { description: "JSON-RPC response" },
        "202": { description: "Notification accepted" },
        "401": { description: "Missing/invalid token; WWW-Authenticate carries resource_metadata" },
        "403": { description: "Origin not allowed, or insufficient_scope (write tool with a read grant)" },
      },
    },
    get: {
      summary: "Not offered: the endpoint is stateless (no standalone SSE stream)",
      responses: { "405": { description: "Method not allowed" } },
    },
    delete: {
      summary: "Not offered: the endpoint is stateless (no sessions to terminate)",
      responses: { "405": { description: "Method not allowed" } },
    },
  },
  "/v1/oauth/consent/{id}": {
    get: {
      summary:
        "Consent page data for a pending MCP authorization request: client, redirect host, requested scopes, the caller's workspaces, and a per-view CSRF token. Cookie session only",
      parameters: [idParam],
      responses: {
        "200": { description: "Consent view" },
        "403": { description: "Not a human session" },
        "404": { description: "Request expired or already used" },
      },
    },
    post: {
      summary:
        "Approve or deny the request for one workspace and scope set; returns redirectTo (client redirect_uri with code, state, iss). Requires the CSRF token from the view; the redirect URI comes from the stored request, never the body",
      parameters: [idParam],
      requestBody: jsonBody({
        type: "object",
        required: ["approve", "csrf"],
        properties: {
          approve: { type: "boolean" },
          workspace: { type: "string" },
          scopes: { type: "array", items: { type: "string", enum: ["read", "write"] } },
          csrf: { type: "string" },
        },
      }),
      responses: {
        "200": { description: "{ redirectTo }" },
        "400": { description: "Invalid decision" },
        "403": { description: "CSRF/user mismatch, not a member of the workspace, or EMAIL_UNVERIFIED (approval needs a confirmed email)" },
        "404": { description: "Request expired or already used" },
        "410": { description: "The chosen workspace is scheduled for deletion" },
      },
    },
  },
  "/v1/workspaces/{ws}/oauth/grants": {
    get: {
      summary:
        "Connected MCP clients (OAuth grants) in the workspace: own for members, all for admins. Cookie session only",
      parameters: [wsParam],
      responses: { "200": { description: "Grants" }, "403": { description: "Forbidden" } },
    },
  },
  "/v1/workspaces/{ws}/oauth/grants/{id}": {
    delete: {
      summary: "Revoke a grant: kills its access and refresh tokens immediately. Own grants, or any as admin",
      parameters: [wsParam, idParam],
      responses: { "200": { description: "Revoked" }, "404": { description: "Not found" } },
    },
  },
};
