# GitHub issue sync (bidirectional)

docketry mirrors linked GitHub issues both ways: local changes push to
GitHub, GitHub webhook events land on the docketry issue. The link map is
`github_issue_links` (one row per repo↔issue pair, created at intake or
import time).

## Setup

The sync runs on the same GitHub App as the rest of the integration —
create it with the manifest flow (`GET /v1/workspaces/:ws/github/manifest`)
or by hand.

App permissions: `issues: write`, `pull_requests: read`,
`contents: read`, `metadata: read`. Events: `issues`, `issue_comment`,
`pull_request`, `pull_request_review`, `push`, `installation`,
`installation_repositories`.

Env vars (`apps/api`):

| var | purpose |
| --- | --- |
| `GITHUB_APP_ID` | App id — `iss` of the JWT used to mint installation tokens |
| `GITHUB_APP_PRIVATE_KEY` | App PEM; env-encoded `\n` is normalized |
| `GITHUB_APP_SLUG` | app slug — its bot (`<slug>[bot]`) is recognized as our own sender |
| `GITHUB_WEBHOOK_SECRET` | X-Hub-Signature-256 verification on `/webhooks/github` |

Outbound calls authenticate as an **installation access token**: the API
signs a short-lived RS256 JWT with the private key, exchanges it at
`POST /app/installations/{id}/access_tokens`, and caches the token per
installation until ~60s before expiry. Repos connected **without** an
installation (manual `repos/connect`, no `installation_id`) receive inbound
events but never mirror outbound — there is no credential to act as.

## What syncs

Outbound (docketry → GitHub) — fires after the local commit, best-effort,
never blocks the request:

- **state** — any `transitionIssue` on a linked issue: terminal states
  (`done` → `state_reason: completed`; `canceled`/`duplicate` →
  `not_planned`) close the GH issue, non-terminal transitions reopen it
  when the link's `gh_state` says it's closed. `gh_state` tracking makes
  transitions that don't change the GH side free (no API call).
- **comments** — `POST .../comments` on a linked issue posts to GH with a
  `**[docketry]**` provenance prefix.
- **labels** — labels attached at issue create are ensured on the repo
  (created if missing, docketry color) then added to the GH issue.

Inbound (GitHub → docketry) — `issues` / `issue_comment` deliveries on
**linked** issues only (unlinked issues stay intake-only):

- `edited` → title/body mirrored to `title`/`description` (the
  `---\nGitHub:` provenance footer is preserved, not doubled)
- `closed` → `done` when `state_reason: completed`, else `canceled` —
  walked through `transitionIssue` so events/queueDeliveries fire
- `reopened` → no-op while the local issue is non-terminal; on a terminal
  issue it can't be honored (the state machine has no exits from
  `done`/`canceled`/`duplicate`) → `sync_conflict` event
- `labeled`/`unlabeled` → label set mirrored; missing docketry labels are
  created by name (GH color or a neutral default)
- `issue_comment.created` → comment with `**@ghuser** via GitHub:` body
  provenance, `via: "github"`, system actor

## Loop prevention

Two independent guards, because each covers what the other can't:

1. **Origin marker.** Inbound writes carry `via: "github"` — a real
   `comments.via` column for comments, `after.via` in the event metadata
   for state/label/edit changes. Every outbound mirror checks `via` first
   and returns before touching the network, so a GH-originated mutation
   can never produce a GH API call. `transitionTo` marks *every* step of a
   walked path, not just the last.
2. **Bot-sender + marker drop.** Our own outbound writes echo back as
   deliveries whose `sender.login` is `<app-slug>[bot]` — dropped before
   any mutation. Mirrored comments additionally start with
   `**[docketry]**`, which the inbound comment handler drops regardless of
   sender.

Net effect: GH close → local `canceled` → no PATCH back; local `done` →
GH PATCH → GH `closed` echo → dropped as bot-sent.

## Conflicts and failures

- `sync_conflict` events record collisions with both sides — e.g. a local
  title edit that diverged from `changes.title.from` (remote wins,
  last-writer-wins), a close/reopen that disagrees with a local terminal
  state, an unresolvable reopen. Nothing is ever silently dropped.
- Failed outbound calls write `github_sync_failed` events on the issue
  timeline (op + error) — a sync failure is visible, not swallowed.
- Both event actions fan out through `queueDeliveries` like any other
  issue event, so webhook subscribers see sync activity too.

## Deliberate scope notes

- Comments authored by internal surfaces (review verdicts, dispatch
  writebacks) are docketry-internal and do not mirror; only the public
  comments route does.
- Push/PR automation (`push`, `pull_request`, `pull_request_review`) is
  GitHub-originated — its transitions carry `via: "github"` and therefore
  never mirror back outbound (a merged PR won't auto-close the linked GH
  issue; use `Closes #N` in the PR body for that).
- Label *removals* never propagate outbound — docketry has no
  remove-label write path, and the outbound mirror only ever adds.
