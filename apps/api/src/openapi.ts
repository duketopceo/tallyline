import { readFileSync } from "node:fs";
import { extraPaths } from "./openapi-extra.js";

const wsParam = {
  name: "ws",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

const keyParam = {
  name: "key",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Z][A-Z0-9]*-\\d+$" },
} as const;

const idParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
} as const;

function jsonBody(schema: Record<string, unknown>) {
  return {
    required: true,
    content: { "application/json": { schema } },
  } as const;
}

const basePaths = {
    "/health": {
      get: {
        summary: "Liveness + dependency check (postgres)",
        responses: {
          "200": { description: "All dependencies healthy" },
          "503": { description: "One or more dependencies down" },
        },
      },
    },
    "/v1/workspaces": {
      post: {
        summary:
          "Create workspace (cookie session only — delegated credentials rejected; creator becomes owner)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["slug", "name"],
                properties: {
                  slug: { type: "string", pattern: "^[a-z0-9-]+$" },
                  name: { type: "string" },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "Workspace created" },
          "409": { description: "Slug taken" },
        },
      },
    },
    "/v1/workspaces/{ws}": {
      patch: {
        summary:
          "Update workspace settings (admin+) — name and allowedDomains (email-domain JIT allowlist)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            allowedDomains: { type: "array", items: { type: "string" } },
          },
        }),
        responses: { "200": { description: "Updated workspace" } },
      },
    },
    "/v1/workspaces/{ws}/teams": {
      get: {
        summary: "List teams in workspace",
        parameters: [wsParam],
        responses: { "200": { description: "Teams" } },
      },
      post: {
        summary: "Create team",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["key", "name"],
          properties: {
            key: { type: "string", pattern: "^[A-Z][A-Z0-9]*$" },
            name: { type: "string" },
            rolloverBehavior: {
              type: "string",
              enum: ["next_cycle", "backlog"],
            },
          },
        }),
        responses: {
          "201": { description: "Team created" },
          "409": { description: "Team key exists" },
        },
      },
    },
    "/v1/workspaces/{ws}/teams/{id}": {
      patch: {
        summary: "Update team (name, rolloverBehavior)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            rolloverBehavior: {
              type: "string",
              enum: ["next_cycle", "backlog"],
            },
          },
        }),
        responses: { "200": { description: "Team" } },
      },
    },
    "/v1/workspaces/{ws}/issues": {
      get: {
        summary:
          "List issues — filters: state, priority, team, assignee, cycle, project, label, source, search; cursor pagination",
        parameters: [
          wsParam,
          { name: "state", in: "query", schema: { type: "string" } },
          { name: "priority", in: "query", schema: { type: "string" } },
          { name: "team", in: "query", schema: { type: "string" } },
          { name: "assignee", in: "query", schema: { type: "string" } },
          { name: "cycle", in: "query", schema: { type: "string" } },
          { name: "project", in: "query", schema: { type: "string" } },
          { name: "label", in: "query", schema: { type: "string" } },
          { name: "source", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 200 },
          },
        ],
        responses: {
          "200": {
            description: "Page of issues with nextCursor",
          },
          "400": { description: "Bad cursor or query" },
        },
      },
      post: {
        summary: "Create issue (mints TEAM-n key; lands in backlog or triage)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["teamKey", "title"],
          properties: {
            teamKey: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            priority: {
              type: "string",
              enum: ["none", "low", "medium", "high", "urgent"],
            },
            state: { type: "string", enum: ["triage", "backlog"] },
            source: {
              type: "string",
              enum: ["web", "github", "slack", "api", "voice"],
            },
            assigneeType: { type: "string", enum: ["human", "agent"] },
            assigneeId: { type: "string", format: "uuid" },
            cycleId: { type: "string", format: "uuid" },
            projectId: { type: "string", format: "uuid" },
            parentId: { type: "string", format: "uuid" },
            labelIds: {
              type: "array",
              items: { type: "string", format: "uuid" },
            },
          },
        }),
        responses: { "201": { description: "Issue created" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}": {
      get: {
        summary: "Issue detail with children + labels",
        parameters: [wsParam, keyParam],
        responses: {
          "200": { description: "Issue" },
          "404": { description: "Not found" },
        },
      },
      patch: {
        summary:
          "Update issue fields; `state` changes route through the lifecycle state machine (409 on illegal transition)",
        parameters: [wsParam, keyParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: ["string", "null"] },
            state: {
              type: "string",
              enum: [
                "triage",
                "backlog",
                "todo",
                "in_progress",
                "in_review",
                "done",
                "canceled",
                "duplicate",
              ],
            },
            priority: {
              type: "string",
              enum: ["none", "low", "medium", "high", "urgent"],
            },
            estimate: { type: ["integer", "null"] },
            dueDate: { type: ["string", "null"], format: "date-time" },
            assigneeType: { type: ["string", "null"] },
            assigneeId: { type: ["string", "null"], format: "uuid" },
            cycleId: { type: ["string", "null"], format: "uuid" },
            projectId: { type: ["string", "null"], format: "uuid" },
            parentId: { type: ["string", "null"], format: "uuid" },
            labelIds: {
              type: "array",
              maxItems: 10,
              items: { type: "string", format: "uuid" },
            },
          },
        }),
        responses: {
          "200": { description: "Updated issue" },
          "409": { description: "Invalid state transition" },
        },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/comments": {
      get: {
        summary: "List comments on an issue",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Comments" } },
      },
      post: {
        summary: "Comment on an issue (writes a `commented` event)",
        parameters: [wsParam, keyParam],
        requestBody: jsonBody({
          type: "object",
          required: ["body"],
          properties: { body: { type: "string" } },
        }),
        responses: { "201": { description: "Comment created" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/summarize": {
      post: {
        summary:
          "LLM-generated issue summary (title + description + comments). 503 LLM_DISABLED when no TALLYLINE_LLM_API_KEY is configured",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Summary text" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/triage-suggest": {
      post: {
        summary:
          "LLM triage verdict — {action: accept|decline, reason}. Advisory only; does not transition the issue",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Triage suggestion" } },
      },
    },
    "/v1/workspaces/{ws}/issues/dup-check": {
      post: {
        summary:
          "Semantic duplicate detection — compares a title/description against open issues; also available as `?dupCheck=1` on issue create",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            description: { type: "string" },
          },
        }),
        responses: { "200": { description: "Possible duplicates" } },
      },
    },
    "/v1/workspaces/{ws}/llm/status": {
      get: {
        summary:
          "LLM assist status — {enabled, model}; the UI hides assist controls when disabled",
        parameters: [wsParam],
        responses: { "200": { description: "Status" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/slack-link": {
      get: {
        summary:
          "Slack mirror binding for this issue (channel + thread ts), or null",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Link or null" } },
      },
      delete: {
        summary:
          "Unlink the Slack thread — mirroring both directions stops cleanly",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Unlinked" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/events": {
      get: {
        summary: "Activity/audit feed for an issue (append-only)",
        parameters: [wsParam, keyParam],
        responses: { "200": { description: "Events" } },
      },
    },
    "/v1/workspaces/{ws}/notifications": {
      get: {
        summary:
          "List the signed-in member's notifications, newest first, cursor-paginated — human sessions only (agent keys get 403)",
        parameters: [wsParam],
        responses: { "200": { description: "Notifications + nextCursor" } },
      },
    },
    "/v1/workspaces/{ws}/notifications/unread-count": {
      get: {
        summary: "Unread notification count for the signed-in member",
        parameters: [wsParam],
        responses: { "200": { description: "{ count }" } },
      },
    },
    "/v1/workspaces/{ws}/notifications/{id}/read": {
      post: {
        summary: "Mark one notification read (404 if it isn't yours)",
        parameters: [wsParam, idParam],
        responses: {
          "200": { description: "Marked read" },
          "404": { description: "Not found / not yours" },
        },
      },
    },
    "/v1/workspaces/{ws}/notifications/read-all": {
      post: {
        summary: "Mark every unread notification read",
        parameters: [wsParam],
        responses: { "200": { description: "{ ok, count }" } },
      },
    },
    "/v1/workspaces/{ws}/issues/{key}/triage": {
      post: {
        summary:
          "Triage action — accept (→ backlog) or decline (→ canceled); 409 unless the issue is in triage",
        parameters: [wsParam, keyParam],
        requestBody: jsonBody({
          type: "object",
          required: ["action"],
          properties: {
            action: { type: "string", enum: ["accept", "decline"] },
          },
        }),
        responses: {
          "200": { description: "Issue transitioned" },
          "409": { description: "Issue not in triage" },
        },
      },
    },
    "/v1/workspaces/{ws}/agents": {
      get: {
        summary: "List registered agents",
        parameters: [wsParam],
        responses: { "200": { description: "Agents" } },
      },
      post: {
        summary: "Register an agent (human session only)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name", "harness"],
          properties: {
            name: { type: "string" },
            harness: { type: "string" },
            capabilities: { type: "array", items: { type: "string" } },
          },
        }),
        responses: { "201": { description: "Agent registered" } },
      },
    },
    "/v1/workspaces/{ws}/agents/{id}/keys/{keyId}": {
      delete: {
        summary:
          "Revoke an agent key; it is 401 on its next call (admin, human session only; agent credentials get 403 FORBIDDEN_AGENT)",
        parameters: [
          wsParam,
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "keyId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Revoked" },
          "403": { description: "Not an admin human session" },
          "404": { description: "Key not found in this workspace" },
        },
      },
    },
    "/v1/workspaces/{ws}/agents/{id}/keys/{keyId}/rotate": {
      post: {
        summary:
          "Rotate an agent key: returns a replacement (plaintext shown once) and ends the old key now, or after graceSeconds (max 86400). Admin, human session only.",
        parameters: [
          wsParam,
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "keyId", in: "path", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  graceSeconds: { type: "integer", minimum: 0, maximum: 86400, default: 0 },
                },
              },
            },
          },
        },
        responses: {
          "201": { description: "New key { id, key, name, scopes, expiresAt, replacesKeyId, oldKeyValidUntil }" },
          "400": { description: "graceSeconds out of range" },
          "403": { description: "Not an admin human session" },
          "404": { description: "Key not found in this workspace, or already expired" },
          "409": { description: "Key is already in a rotation grace window" },
        },
      },
    },
    "/v1/workspaces/{ws}/agents/{id}/keys": {
      get: {
        summary: "List an agent's keys, redacted (human session only)",
        parameters: [wsParam],
        responses: { "200": { description: "Agent keys" } },
      },
      post: {
        summary:
          "Mint an agent key — plaintext returned once (human session only)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["read", "write"] },
            },
            expiresInDays: { type: "number" },
          },
        }),
        responses: { "201": { description: "Agent key minted" } },
      },
    },
    "/v1/auth/token": {
      post: {
        summary:
          "Exchange a session cookie for a short-lived access JWT (15 min)",
        responses: {
          "200": { description: "access_token, token_type, expires_in" },
          "401": { description: "No/expired session" },
        },
      },
    },
    "/v1/whoami": {
      get: {
        summary:
          "Credential introspection — resolves the bearer credential to {type, id, name, scopes, workspaceId, workspaceSlug}; human responses include memberships[] and role for the bound workspace",
        responses: {
          "200": {
            description:
              "type: 'agent' for tly_agt_* keys, 'human' for sessions/PATs/JWTs",
          },
          "401": { description: "Unauthenticated" },
        },
      },
    },
    "/v1/auth/methods": {
      get: {
        summary:
          "Public auth discovery — {password: bool, providers: [{key,type,label}]}; the login page renders from this",
        responses: { "200": { description: "Available auth methods" } },
      },
    },
    "/v1/auth/oauth/{provider}/start": {
      get: {
        summary:
          "OAuth leg 1 — issues state cookies (PKCE, nonce, return_to, invite, login_nonce) and 302s to the provider authorize URL",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "return_to", in: "query", schema: { type: "string" } },
          { name: "invite", in: "query", schema: { type: "string" } },
          { name: "login_nonce", in: "query", schema: { type: "string" } },
        ],
        responses: { "302": { description: "Redirect to provider" } },
      },
    },
    "/v1/auth/oauth/{provider}/callback": {
      get: {
        summary:
          "OAuth leg 2 — provider redirect lands here; verifies state, exchanges code, resolves identity, mints a one-time code and redirects to the web origin's /api/auth/callback",
        parameters: [
          { name: "provider", in: "path", required: true, schema: { type: "string" } },
          { name: "code", in: "query", schema: { type: "string" } },
          { name: "state", in: "query", schema: { type: "string" } },
        ],
        responses: { "302": { description: "Redirect to web origin" } },
      },
    },
    "/v1/auth/oauth/exchange": {
      post: {
        summary:
          "OAuth leg 3 — exchange a one-time code for a session. Dispatches on purpose: login claims and mints; pending-bootstrap returns context until a bootstrap payload arrives; pending-link returns link context (409) until /oauth/link completes",
        requestBody: jsonBody({
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
            login_nonce: { type: "string" },
            bootstrap: {
              type: "object",
              properties: {
                workspaceSlug: { type: "string" },
                workspaceName: { type: "string" },
                teamKey: { type: "string" },
              },
            },
          },
        }),
        responses: {
          "200": { description: "purpose: login|pending-bootstrap (+session cookie on login)" },
          "409": { description: "purpose: pending-link + link context" },
          "410": { description: "code expired or already used" },
        },
      },
    },
    "/v1/auth/oauth/link": {
      post: {
        summary:
          "Complete a pending-link: prove control of the matched account (password when set, else live session) then write the auth_identities row. Never mints a session",
        requestBody: jsonBody({
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string" },
            password: { type: "string" },
          },
        }),
        responses: {
          "200": { description: "Linked" },
          "401": { description: "proof failed" },
          "410": { description: "code expired or already used" },
        },
      },
    },
    "/v1/auth/accept-invite": {
      post: {
        summary:
          "Accept an invite — resolves the caller from cookie session or PAT (never a body userId), enforces email binding; unauthenticated {name,password} claims create account+member+session on password-enabled installs",
        requestBody: jsonBody({
          type: "object",
          required: ["token"],
          properties: {
            token: { type: "string" },
            name: { type: "string" },
            password: { type: "string" },
          },
        }),
        responses: {
          "200": { description: "Joined (existing account)" },
          "201": { description: "Joined (new account, session minted)" },
          "403": { description: "invite email mismatch" },
          "410": { description: "invite expired/revoked/used" },
        },
      },
    },
    "/v1/auth/providers": {
      get: {
        summary: "List sign-in providers (instance admins; secrets masked, env-sourced rows marked)",
        responses: { "200": { description: "Providers" }, "403": { description: "not instance admin" } },
      },
      post: {
        summary: "Add a sign-in provider (instance admins; secret encrypted at rest)",
        requestBody: jsonBody({
          type: "object",
          required: ["key", "type", "label", "clientId", "clientSecret"],
          properties: {
            key: { type: "string" },
            type: { type: "string", enum: ["github", "google", "oidc"] },
            label: { type: "string" },
            clientId: { type: "string" },
            clientSecret: { type: "string" },
            issuer: { type: "string" },
            scopes: { type: "array", items: { type: "string" } },
          },
        }),
        responses: { "201": { description: "Provider created" }, "409": { description: "env-shadowed key" } },
      },
    },
    "/v1/auth/providers/{id}": {
      patch: {
        summary: "Update a provider (write-only clientSecret; env-shadowed rows reject)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated" } },
      },
      delete: {
        summary: "Delete a provider",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/v1/auth/providers/{id}/test": {
      post: {
        summary: "Connectivity probe — fetches the provider's authorize/discovery endpoint (egress-constrained)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ok, status}" }, "422": { description: "unreachable or not permitted" } },
      },
    },
    "/v1/workspaces/{ws}/members": {
      get: {
        summary: "List workspace members (any credential with workspace access — assignee resolution)",
        parameters: [wsParam],
        responses: { "200": { description: "members[]: {id,userId,name,email,role}" } },
      },
    },
    "/v1/workspaces/{ws}/members/{id}": {
      patch: {
        summary: "Change a member's role (admin+; owner rows and owner grants require owner; last owner protected)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["role"],
          properties: { role: { type: "string", enum: ["member", "admin", "owner"] } },
        }),
        responses: { "200": { description: "Updated" }, "409": { description: "last owner" } },
      },
      delete: {
        summary: "Remove a member (admin+; owner removal requires owner; last owner protected)",
        parameters: [wsParam],
        responses: { "200": { description: "Removed" }, "409": { description: "last owner" } },
      },
    },
    "/v1/workspaces/{ws}/invites": {
      get: {
        summary: "List pending invites (admin+)",
        parameters: [wsParam],
        responses: { "200": { description: "invites[]" } },
      },
      post: {
        summary: "Create an invite — opaque token hashed at rest, optional email binding + team, default 7d expiry; joinUrl built from WEB_URL",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            email: { type: "string" },
            role: { type: "string", enum: ["member", "admin"] },
            teamId: { type: "string" },
            expiresInDays: { type: "integer" },
          },
        }),
        responses: { "201": { description: "{id, joinUrl, expiresAt}" } },
      },
    },
    "/v1/workspaces/{ws}/invites/{id}": {
      delete: {
        summary: "Revoke a pending invite (admin+)",
        parameters: [wsParam],
        responses: { "200": { description: "Revoked" } },
      },
    },
    "/v1/workspaces/{ws}/tokens": {
      get: {
        summary: "List your personal access tokens (human session only)",
        parameters: [wsParam],
        responses: { "200": { description: "Tokens" } },
      },
      post: {
        summary:
          "Mint a personal access token `tly_pat_*` — plaintext returned once (human session only)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            scopes: {
              type: "array",
              items: { type: "string", enum: ["read", "write"] },
            },
            expiresAt: { type: "string", format: "date-time" },
          },
        }),
        responses: { "201": { description: "Token minted" } },
      },
    },
    "/v1/workspaces/{ws}/tokens/{id}": {
      delete: {
        summary: "Revoke a personal access token",
        parameters: [wsParam],
        responses: { "200": { description: "Revoked" } },
      },
    },
    "/v1/workspaces/{ws}/projects": {
      get: {
        summary: "List projects",
        parameters: [wsParam],
        responses: { "200": { description: "Projects" } },
      },
      post: {
        summary: "Create project",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            status: {
              type: "string",
              enum: [
                "backlog",
                "planned",
                "started",
                "paused",
                "completed",
                "canceled",
              ],
            },
            teamKey: { type: "string" },
            startDate: { type: "string", format: "date-time" },
            targetDate: { type: "string", format: "date-time" },
          },
        }),
        responses: {
          "201": { description: "Project created" },
          "400": { description: "targetDate before startDate" },
        },
      },
    },
    "/v1/workspaces/{ws}/projects/{id}": {
      patch: {
        summary:
          "Update project (name, description, status, startDate, targetDate — merged window validated)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: ["string", "null"] },
            status: {
              type: "string",
              enum: [
                "backlog",
                "planned",
                "started",
                "paused",
                "completed",
                "canceled",
              ],
            },
            startDate: { type: ["string", "null"], format: "date-time" },
            targetDate: { type: ["string", "null"], format: "date-time" },
          },
        }),
        responses: {
          "200": { description: "Project" },
          "422": { description: "Inverted start/target window" },
        },
      },
      delete: {
        summary:
          "Delete project — its issues are unassigned, milestones cascade",
        parameters: [wsParam],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/v1/workspaces/{ws}/milestones": {
      get: {
        summary:
          "List every project milestone in the workspace (roadmap pulls this once)",
        parameters: [wsParam],
        responses: { "200": { description: "Milestones" } },
      },
    },
    "/v1/workspaces/{ws}/projects/{id}/milestones": {
      get: {
        summary: "List a project's milestones (sortOrder, then createdAt)",
        parameters: [wsParam],
        responses: { "200": { description: "Milestones" } },
      },
      post: {
        summary:
          "Create a milestone — title + optional targetDate (undated = checklist item), sortOrder, done",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string" },
            targetDate: { type: "string", format: "date-time" },
            sortOrder: { type: "number" },
            done: { type: "boolean" },
          },
        }),
        responses: { "201": { description: "Milestone created" } },
      },
    },
    "/v1/workspaces/{ws}/projects/{id}/milestones/{mid}": {
      patch: {
        summary: "Update a milestone (title, targetDate, sortOrder, done)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            title: { type: "string" },
            targetDate: { type: ["string", "null"], format: "date-time" },
            sortOrder: { type: "number" },
            done: { type: "boolean" },
          },
        }),
        responses: { "200": { description: "Milestone" } },
      },
      delete: {
        summary: "Delete a milestone",
        parameters: [wsParam],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/v1/workspaces/{ws}/cycles": {
      get: {
        summary:
          "List cycles — `?team=<key>` filter, `?active=true` for the team's flagged current cycle",
        parameters: [wsParam],
        responses: { "200": { description: "Cycles" } },
      },
      post: {
        summary:
          "Create cycle (auto-numbered per team; `isActive` demotes the team's previous active cycle)",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["teamKey", "startsAt", "endsAt"],
          properties: {
            teamKey: { type: "string" },
            name: { type: "string" },
            startsAt: { type: "string", format: "date-time" },
            endsAt: { type: "string", format: "date-time" },
            isActive: { type: "boolean" },
          },
        }),
        responses: { "201": { description: "Cycle created" } },
      },
    },
    "/v1/workspaces/{ws}/cycles/{id}": {
      get: {
        summary: "Fetch one cycle",
        parameters: [wsParam],
        responses: { "200": { description: "Cycle" } },
      },
      patch: {
        summary:
          "Update cycle (name, window, `isActive` — activating demotes the team's previous active cycle)",
        parameters: [wsParam],
        responses: { "200": { description: "Cycle" } },
      },
      delete: {
        summary: "Delete cycle (unassigns its issues first)",
        parameters: [wsParam],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/v1/workspaces/{ws}/cycles/{id}/complete": {
      post: {
        summary:
          "Complete a cycle — clears the active flag and rolls unfinished issues to the next cycle or the backlog per the team's rolloverBehavior",
        parameters: [wsParam],
        responses: { "200": { description: "Cycle + rollover summary" } },
      },
    },
    "/v1/workspaces/{ws}/views": {
      get: {
        summary: "List saved views (own + shared)",
        parameters: [wsParam],
        responses: { "200": { description: "Views" } },
      },
      post: {
        summary: "Create a saved view",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name", "filters"],
          properties: {
            name: { type: "string" },
            filters: { type: "object" },
            shared: { type: "boolean" },
          },
        }),
        responses: { "201": { description: "View created" } },
      },
    },
    "/v1/workspaces/{ws}/views/{id}": {
      patch: {
        summary: "Update view (owner only)",
        parameters: [wsParam],
        responses: { "200": { description: "View" } },
      },
      delete: {
        summary: "Delete view (owner only)",
        parameters: [wsParam],
        responses: { "200": { description: "Deleted" } },
      },
    },
    "/v1/workspaces/{ws}/insights": {
      get: {
        summary:
          "Workspace metrics computed from the event log — cycle time (avg/p50/p90 + weekly), burnup, per-cycle velocity, throughput split by actor (human/agent/system)",
        parameters: [wsParam],
        responses: { "200": { description: "Insights payload" } },
      },
    },
    "/v1/workspaces/{ws}/events": {
      get: {
        summary:
          "Workspace activity feed — newest-first, cursor-paginated; each event is joined to its issue key/title and actor name",
        parameters: [
          wsParam,
          { name: "cursor", in: "query", schema: { type: "string" } },
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", default: 50, maximum: 200 },
          },
        ],
        responses: {
          "200": { description: "Page of feed events with nextCursor" },
          "400": { description: "Bad cursor" },
        },
      },
    },
    "/v1/workspaces/{ws}/events/stream": {
      get: {
        summary:
          "Live workspace event stream (SSE, text/event-stream) — emits committed events ~1s cadence with heartbeat comments; resume via Last-Event-ID header or ?after=<eventId>",
        parameters: [
          wsParam,
          { name: "after", in: "query", schema: { type: "integer" } },
          { name: "Last-Event-ID", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "text/event-stream" },
          "400": { description: "Bad resume cursor" },
          "401": { description: "Unauthenticated" },
        },
      },
    },
    "/v1/workspaces/{ws}/labels": {
      get: {
        summary: "List labels",
        parameters: [wsParam],
        responses: { "200": { description: "Labels" } },
      },
      post: {
        summary: "Create label",
        parameters: [wsParam],
        requestBody: jsonBody({
          type: "object",
          required: ["name", "color"],
          properties: {
            name: { type: "string" },
            color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            teamKey: { type: "string" },
          },
        }),
        responses: { "201": { description: "Label created" } },
      },
    },
    "/v1/workspaces/{ws}/labels/{id}": {
      patch: {
        summary: "Update label name/color",
        parameters: [wsParam, idParam],
        requestBody: jsonBody({
          type: "object",
          properties: {
            name: { type: "string" },
            color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
          },
        }),
        responses: {
          "200": { description: "Label updated" },
          "404": { description: "Not found" },
        },
      },
      delete: {
        summary: "Delete label (detaches from issues via cascade)",
        parameters: [wsParam, idParam],
        responses: {
          "200": { description: "Deleted" },
          "404": { description: "Not found" },
        },
      },
    },
} as const;

function packageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// merge per path item so a path split across both files (same path, different
// methods) keeps every operation
function mergePaths(
  ...sources: Record<string, Record<string, unknown>>[]
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const src of sources) {
    for (const [path, item] of Object.entries(src)) {
      out[path] = { ...out[path], ...item };
    }
  }
  return out;
}

export const openApiDoc = {
  openapi: "3.1.0",
  info: {
    title: "Tallyline API",
    version: packageVersion(),
    description:
      "Self-hostable, agent-native issue tracker. All resources are workspace-scoped; issue keys are TEAM-n.",
  },
  servers: [
    { url: "https://api.tallyline.app", description: "Tallyline Cloud" },
    {
      url: "/",
      description: "Self-hosted — same origin that served this document",
    },
  ],
  paths: mergePaths(basePaths, extraPaths),
};
