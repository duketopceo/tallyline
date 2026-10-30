# tallyline MCP server

`apps/mcp-server` (`@tallyline/mcp-server`) exposes the issue/workflow surface
to MCP clients — Claude Code, Cursor, opencode, or anything else that speaks
MCP. It is a thin client over the REST API: every tool call is an
authenticated HTTP request, so the API's auth, scope, and state-machine rules
stay the single source of truth.

## Environment

| Var | Required | Notes |
| --- | --- | --- |
| `TALLYLINE_TOKEN` | stdio / env-http | `tly_agt_*` agent key (preferred — actions are attributed to the agent) or `tly_pat_*` personal token. Mutating tools require the `write` scope. |
| `TALLYLINE_WORKSPACE` | stdio / env-http | Workspace slug, e.g. `acme`. |
| `TALLYLINE_API_URL` | no | API base URL. Default `http://localhost:4000`. |
| `TALLYLINE_ALLOW_API_URL_OVERRIDE` | no | HTTP passthrough only — `1` honors per-request `x-tallyline-api-url`. Off by default. |

stdio always needs `TALLYLINE_TOKEN` + `TALLYLINE_WORKSPACE` — missing vars
fail fast: the server writes the missing names to stderr and exits 1.
`--http` needs them only for single-tenant mode; with neither set it runs
per-request header passthrough instead (see below).

## Transports

- **stdio** (default) — what local MCP clients spawn:
  `tsx apps/mcp-server/src/index.ts` (dev) or `tallyline-mcp` / `node
  apps/mcp-server/dist/index.js` after `pnpm --filter @tallyline/mcp-server
  build`.
- **Streamable HTTP** — `--http[=PORT]` (or `MCP_HTTP_PORT`, default `3101`)
  serves a stateless `POST /mcp` endpoint plus `GET /health`. Credentials
  resolve per deployment: with `TALLYLINE_TOKEN`+`TALLYLINE_WORKSPACE` set,
  every request shares them (single-tenant). With neither set the endpoint
  runs **passthrough** — each request supplies `Authorization: Bearer
  <key>` + `x-tallyline-workspace: <slug>` headers, which is what hosted
  multi-tenant front-ends (Klavis Strata `externalServers`, gateways) send.
  `x-tallyline-api-url` is honored only when the deployment sets
  `TALLYLINE_ALLOW_API_URL_OVERRIDE=1`. See [klavis.md](./klavis.md).

## Client config

Claude Code — `claude mcp add` or `.mcp.json`:

```json
{
  "mcpServers": {
    "tallyline": {
      "command": "node",
      "args": ["/path/to/tallyline/apps/mcp-server/dist/index.js"],
      "env": {
        "TALLYLINE_API_URL": "http://localhost:4000",
        "TALLYLINE_TOKEN": "tly_agt_…",
        "TALLYLINE_WORKSPACE": "acme"
      }
    }
  }
}
```

Cursor — same shape in `~/.cursor/mcp.json`. For a source checkout without a
build, swap the command for `tsx` + `apps/mcp-server/src/index.ts`.

Mint an agent key first (human session required — agent keys can't mint
agents):

```sh
curl -X POST $API/v1/workspaces/$WS/agents \
  -H "cookie: tly_session=…" -H 'content-type: application/json' \
  -d '{"name":"claude","harness":"claude-code","capabilities":["code"]}'
curl -X POST $API/v1/workspaces/$WS/agents/$AGENT_ID/keys \
  -H "cookie: tly_session=…" -H 'content-type: application/json' \
  -d '{"name":"local","scopes":["read","write"]}'   # plaintext key returned once
```

## Tools

| Tool | Writes | Summary |
| --- | --- | --- |
| `whoami` | — | Resolve the credential to `{type, id, name, scopes}` |
| `list_issues` | — | Filter by state, priority, team, assignee, cycle, label, source, search; cursor-paginated |
| `ready` | — | `todo` issues ordered urgent→none then oldest; `mine` restricts to your assignments |
| `inbox` | `limit?` | what is waiting for you: `waiting` (assigned or delegated, unblocked), `mentions` (comments that @-mention you) and `answers` (human replies to your questions on your sessions); the last two are agent-only, oldest first, and only newer than your last `ack` |
| `ack` | `through` | acknowledge mentions and answers up to an ISO time (the last handled item's `createdAt`); the mark only moves forward |
| `get_issue` | — | Full issue incl. labels/children; `includeComments` appends the thread |
| `create_issue` | yes | Title/desc/state(triage\|backlog)/priority/team/assignee/labels/project/cycle/parent |
| `update_issue` | yes | Patch any mutable field; state transitions validated; `null` clears nullable fields |
| `triage_issue` | yes | `accept`→backlog, `decline`→canceled |
| `comment` | yes | Post a comment as the credential's identity |
| `claim` | yes | Assign to yourself + move to `in_progress` (hops via `todo` from `backlog`) |
| `list_agents` / `list_members` / `list_teams` / `list_labels` / `list_projects` / `list_cycles` | — | Workspace resources, slim views (`list_members` returns name/email/role — assignee resolution) |
| `create_team` | yes | Create a team (`key` 1-6 chars `A-Z0-9`, `name`, optional `rolloverBehavior`). Humans need the admin role; agent keys pass on write scope |
| `create_project` / `update_project` | yes | Create or patch a project. Names are unique case-insensitively (`DUPLICATE_NAME`), because plan import finds its project by name |
| `import_plan` | yes | Import a ce-plan markdown file as issues. `mode` defaults to `dry_run` (returns the diff and a `diffHash`, writes nothing); `apply` needs that hash. `STALE_DIFF` carries the new diff. No `evidence` or `historical` input: agents cannot write done or in-progress state. See [import.md](import.md) |
| `create_cycle` | yes | Create a dated cycle for a team (inactive unless `isActive`); teams with the weekly auto-schedule get theirs created for them |
| `assign_cycle` | yes | Put issues (by key) into a cycle, or `cycleId: null` to clear; cross-team and cross-workspace cycles are refused |
| `list_events` | — | Workspace activity feed, cursor-paginated |

Tool outputs are compact JSON (both `content` text and `structuredContent`),
carrying only fields an agent needs — key, title, state, priority, assignee —
never full row dumps.

## Errors

API errors surface as MCP tool errors (`isError: true`) preserving the API's
`{error:{code,message}}` envelope — e.g. a read-scoped key calling
`create_issue` returns `FORBIDDEN_SCOPE`, an illegal state move returns
`INVALID_TRANSITION`, a missing issue returns `NOT_FOUND`. Tool errors never
crash the server.

## Remote endpoint with OAuth (hosted)

The API also serves the same tool surface over Streamable HTTP at
`/mcp` (for the hosted cloud, `https://api.tallyline.app/mcp`) and acts as its
own OAuth 2.1 authorization server, so Claude, ChatGPT/Codex and other remote
MCP clients connect with a browser sign-in instead of a pasted key. The tool
definitions are not forked: `apps/mcp-server/src/lib.ts` exports
`createMcpServer`, and the API mounts it. stdio and `--http` modes above are
unchanged.

Spec basis: MCP authorization and Streamable HTTP, protocol revision
**2026-07-28** (current; the draft at modelcontextprotocol.io was read on
2026-10-11). The authorization server follows OAuth 2.1, RFC 9728 (protected
resource metadata), RFC 8414 (AS metadata), RFC 7591 (DCR), Client ID Metadata
Documents (draft-ietf-oauth-client-id-metadata-document-00), RFC 8707
(resource indicators), RFC 9207 (`iss`) and RFC 7009 (revocation). The `/mcp`
transport speaks the handshake-based stateless JSON mode (`2025-11-25` and
earlier): the pinned SDK (1.31.0) does not yet implement the `2026-07-28`
per-request-metadata transport, so clients that send it fall back to
`initialize`.

| Piece | URL (cloud) |
| --- | --- |
| MCP endpoint (connector URL) | `https://api.tallyline.app/mcp` |
| Protected resource metadata | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` |
| Authorization server metadata | `/.well-known/oauth-authorization-server` |
| Authorize / token / register / revoke | `/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke` |
| Consent page | `<WEB_URL>/oauth/consent` |

Behaviour:

- Public clients only: PKCE `S256` is required (`plain` is refused), no client
  secrets. Clients register by Client ID Metadata Document (an https
  `client_id` URL, fetched through the SSRF guard, 5 KB cap, cached) or by
  dynamic registration (`/oauth/register`).
- `redirect_uri` must exactly match a registered URI (https, http loopback, or an RFC 8252 private-use app scheme such as `app.example.ios:/cb`, which must contain a dot and is matched exactly;
  a registered loopback URI without a port matches any port, RFC 8252). A bad
  client or redirect URI is never redirected to.
- The `resource` parameter must be the MCP URL; tokens are bound to it.
  Access tokens (`tly_oat_`, 1 h) are accepted only at `/mcp`, never by the
  REST API directly. Refresh tokens (`tly_ort_`, 30 d) rotate on every use;
  presenting a used one revokes the grant. Codes live 60 s and are single
  use; replaying one revokes everything it produced. All tokens and codes
  are SHA-256 hashed at rest.
- Scopes are `read` and `write` (the existing token scopes). The consent page
  asks for one workspace and read-only or read-write; a read-only grant that
  calls a mutating tool gets `403 insufficient_scope` with a
  `WWW-Authenticate` step-up challenge.
- Each grant (user x workspace x client) owns a connector agent
  (`harness: mcp-connector`), so writes carry agent provenance while the grant
  records the consenting user. A user removed from the workspace loses access
  on the next request.
- Management API for the Agents & keys settings UI (cookie session only):
  `GET /v1/workspaces/:ws/oauth/grants` (own for members, all for admins) and
  `DELETE /v1/workspaces/:ws/oauth/grants/:id`. Audit rows are written to
  `events` with `entity_type = oauth_grant`.

Env: `API_BASE_URL` (the issuer), `WEB_URL` (consent page), optional
`MCP_RESOURCE_URL` (default `<API_BASE_URL>/mcp`) and `MCP_ALLOWED_ORIGINS`
(browser origins allowed at `/mcp`; default `https://claude.ai,https://chatgpt.com`;
requests with no `Origin` are always allowed).

Client requirements this was built against: Claude (custom connectors) needs
a `401` + `resource_metadata` challenge, `resource` equal to the URL the user
typed, `S256` PKCE, CIMD (advertising `client_id_metadata_document_supported`
and `none` in `token_endpoint_auth_methods_supported`) or DCR, redirect URI
`https://claude.ai/api/mcp/auth_callback` plus port-agnostic loopback for
Claude Code, rotating refresh tokens, form-encoded token requests and 10 s
endpoint latency. ChatGPT/Codex need `code_challenge_methods_supported`
containing `S256`, the `resource` parameter copied into the token audience,
and, because this server returns `iss` on every authorization response,
`authorization_response_iss_parameter_supported: true`.
