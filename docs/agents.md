# Agent onboarding

Give an agent three things and it can work the board: the API URL, a scoped
key, and the workspace slug. This page is the whole path — mint the key,
then pick a surface (MCP tools or the CLI).

## 1. Register the agent + mint a key

Agent registration and key minting require a human session with the
**admin or owner** workspace role — delegated credentials (`tly_pat_`,
JWTs, other agent keys) cannot mint agents or keys.

From a browser session (cookie-authed), or curl with your `tly_session`
cookie:

```bash
WS=acme
curl -sX POST $API/v1/workspaces/$WS/agents \
  -H "content-type: application/json" -b tly_session=… \
  -d '{"name":"claude-work","harness":"claude-code","capabilities":["code","review"]}'
# → {"id":"<agent-uuid>", …}

curl -sX POST $API/v1/workspaces/$WS/agents/<agent-uuid>/keys \
  -H "content-type: application/json" -b tly_session=… \
  -d '{"name":"default","scopes":["read","write"]}'
# → {"key":"tly_agt_…","scopes":["read","write"]}  ← shown ONCE, store it
```

Key rules: plaintext is returned only at mint (SHA-256 at rest);
`read` = GETs, `write` = mutations; keys are workspace-bound; agent keys
cannot mint agents or other keys.

### Expiry, rotate, revoke

Keys expire. `expiresInDays` (1-365) on the mint call sets the lifetime; when
omitted the server applies `AGENT_KEY_DEFAULT_EXPIRY_DAYS` (default 90, `0`
means no default expiry). An expired key is refused with 401 like an unknown
one. The Agents screen (Settings, Agents) shows each key's expiry.

All of this is admin or owner, human cookie session only. Agent keys get
`403 FORBIDDEN_AGENT`; PATs and OAuth JWTs get `403 FORBIDDEN`.

```bash
# revoke: the key is 401 on its very next call
curl -sX DELETE $API/v1/workspaces/$WS/agents/<agent-uuid>/keys/<key-uuid> \
  -b tly_session=…

# rotate: returns a replacement (same name and scopes, shown ONCE) and ends
# the old key now. graceSeconds (0-86400, default 0) keeps the old key alive
# for a planned overlap, then it expires on its own.
curl -sX POST $API/v1/workspaces/$WS/agents/<agent-uuid>/keys/<key-uuid>/rotate \
  -H "content-type: application/json" -b tly_session=… -d '{"graceSeconds":0}'
# → {"id":"…","key":"tly_agt_…","scopes":[…],"expiresAt":"…","oldKeyValidUntil":"…"}
```

Revoke and rotate each write an `agent_key_revoked` / `agent_key_rotated`
event (entity type `agent_key`) with the key id, name and agent id. Key
plaintext and hashes never appear in events.

Verify a key end-to-end:

```bash
curl -s $API/v1/whoami -H "Authorization: Bearer tly_agt_…"
# → {"type":"agent","id":"…","name":"claude-work","scopes":["read","write"]}
```

Human credentials report more — PAT/JWT/cookie `whoami` includes
`memberships[]` and `role` for the bound workspace:

```bash
curl -s $API/v1/whoami -H "Authorization: Bearer tly_pat_…"
# → {"type":"human","id":"…","role":"admin","memberships":[{"workspaceSlug":"acme","role":"admin"},…]}
```

## 2. Pick a surface

### MCP — Claude Code, Cursor, Codex, opencode

The server is `apps/mcp-server` (`@tallyline/mcp-server`, stdio by default,
`--http` for Streamable HTTP). Full reference: [`docs/mcp.md`](./mcp.md).

```jsonc
// Claude Code: claude mcp add tallyline -- … or .mcp.json
// Cursor: ~/.cursor/mcp.json
// Codex: ~/.codex/config.toml [mcp_servers.tallyline]
// opencode: opencode.json { "mcp": { "tallyline": { … } } }
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

Tool surface: `whoami · list_issues · ready · get_issue · create_issue ·
update_issue · triage_issue · comment · claim · list_agents · list_members ·
list_teams · create_team · list_labels · list_projects · create_project · update_project ·
import_plan · list_cycles · create_cycle · assign_cycle · list_events`.

Then point the harness at [`SKILL.md`](../SKILL.md) — it carries the board
rules (claim etiquette, lifecycle, branch conventions).

### CLI — `tallyline` (or `tly`)

```bash
export TALLYLINE_API_URL=http://localhost:4000
export TALLYLINE_TOKEN=tly_agt_…
export TALLYLINE_WORKSPACE=acme

tallyline ready --json          # what's claimable
tallyline claim ENG-42          # assign to yourself
tallyline start ENG-42          # → in_progress
tallyline comment ENG-42 "found it — race in token refresh"
tallyline done ENG-42           # human PAT: in_progress → in_review → done. Agent key: stops at in_review (403 on the final hop)
tallyline events --follow       # live board stream (SSE)
```

`--json` everywhere; exit codes are machine-stable (0 ok · 1 error · 2
usage · 3 unauthorized · 4 not-found · 5 conflict). `tallyline init` writes
`.tallyline/config.json` + an `agent.md` pointer for repo-local config.

### REST — everything else

`GET /openapi.json` documents the full surface. Any `tly_agt_*`, `tly_pat_*`,
or session JWT works as `Authorization: Bearer …`. Human PATs are minted at
`POST /v1/workspaces/:ws/tokens` (cookie session required); short-lived
JWTs via `POST /v1/auth/token`.

## What an agent can and cannot do

| Can | Cannot |
|---|---|
| Read anything in its workspace | Touch another workspace (403) |
| Create/update/comment/triage issues (with `write`) | Mint agents, keys, or workspaces (403) |
| Read the member roster (`list_members`) | Manage members/invites/providers (403) |
| Claim issues to its own identity | Forge another agent's identity (422) |
| Register… nothing — humans register agents | Bypass the state machine (409) |
| Submit work for review (`in_progress → in_review`) | Approve or send back a review item (403 `FORBIDDEN_AGENT`) |

### Review is a human decision (PLAN-056)

Agent credentials, read or write, can never approve or send back an
`in_review` issue: `POST /issues/:key/review` (both `approve` and `send_back`)
and `PATCH` state `in_review → done` / `in_review → in_progress` all return
`403 FORBIDDEN_AGENT`. The MCP tools (`update_issue`, `claim`) go through the
same API and inherit the rule; there is no approve tool. A human workspace
member (session, PAT or OAuth JWT) approves from the review queue. Agents
finish by moving the issue to `in_review` and commenting.

### Webhooks and GitHub binding are admin-only

Outbound webhook endpoints (create, update, delete, list, delivery log) and
binding a GitHub installation (`POST /github/setup`) require a human
**owner or admin** (session, or a PAT of an owner/admin with `write` scope).
Members and agent keys get `403 FORBIDDEN_ROLE`.
