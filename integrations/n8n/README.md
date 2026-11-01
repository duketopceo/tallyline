# n8n-nodes-tallyline

n8n community nodes for [tallyline](https://github.com/duketopceo/tallyline) —
issue operations plus a signed outbound-webhook trigger, for self-hosted
and cloud n8n.

## Install

```bash
# self-hosted n8n — community node installation
cd ~/.n8n && mkdir -p nodes && cd nodes
npm install n8n-nodes-tallyline
# or: Settings → Community Nodes → install "n8n-nodes-tallyline"
```

## Credentials

Create **tallyline API** credentials:

| Field | Value |
|---|---|
| Base URL | Root URL of your tallyline API — e.g. `http://localhost:4000` for local dev, `https://tallyline.example.com` self-hosted (trailing slashes are ignored) |
| Workspace | Workspace slug — every resource is workspace-scoped, resolved once here |
| API Key | `tly_agt_*` agent key or `tly_pat_*` personal access token |

Mint a key from a browser session or curl (see
[`docs/agents.md`](https://github.com/duketopceo/tallyline/blob/main/docs/agents.md)):

```bash
curl -X POST $API/v1/workspaces/$WS/agents/$AGENT_ID/keys \
  -H "content-type: application/json" -b tly_session=… \
  -d '{"name":"n8n","scopes":["read","write"]}'
```

The credentials test calls `GET /v1/whoami`.

## tallyline (action node)

Issue operations against the workspace API: create, get, update, delete,
list/search (state, priority, team, assignee, cycle, project, label,
source, full-text), comment, and transition — plus loadOptions-driven
pickers for teams, labels, projects, cycles, and assignees.

The **Intake** resource submits external events (errors, bugs, help
requests) into the intake pipeline: set a stable **fingerprint** from the
source so repeats dedupe into one issue with an occurrence count instead
of flooding the board. Fingerprints match workspace-wide regardless of
provider — namespace them (`sentry:my-project:123`) so unrelated sources
don't merge.

## tallyline Trigger (webhook trigger)

On activation, the node registers a `webhook_endpoints` row on the
workspace pointing at n8n's webhook URL — the API accepts a
caller-provided secret, so the trigger generates a fresh
`tly_wh_…` secret per activation. Every delivery arrives
`X-Tallyline-Signature: sha256=…` signed; unsigned or forged requests are
rejected silently and never start a run. Deactivation deletes the
endpoint.

Events: `issue.created`, `issue.state_changed`, `issue.commented`,
`issue.github_review`, `issue.dispatched`, `issue.dispatch_delivered`,
`issue.dispatch_failed`, `issue.session_update` — or **All events** (`*`).

Each run item carries `{deliveryId, action, ...event payload}`.

Requirements: your n8n instance must be reachable from tallyline —
self-hosters behind NAT should expose n8n through a tunnel/reverse proxy
(the endpoint URL is what tallyline POSTs to).

## License

MIT
