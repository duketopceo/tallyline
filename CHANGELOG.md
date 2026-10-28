# Changelog

All notable changes to Tallyline (formerly docketry). Format loosely follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## [Unreleased]

### Added

- **Native app redirect schemes** (OAuth for `/mcp`): `redirect_uris` may now be an RFC 8252 §7.1 private-use scheme (reverse-domain, for example `app.tallyline.ios:/oauth/callback`). Matched by exact string, PKCE only; schemes without a dot (`javascript:`, `data:`, `file:`) stay rejected. Groundwork for the iOS client.
- **Offline-client groundwork** (see `docs/offline-sync.md`): `GET /issues?updatedSince=` delta reads with stable keyset paging, and `Idempotency-Key` on issue create, issue update and comment create (migration `0038_idempotency_keys`).
- **QR pairing and a device registry for the mobile app** (see `docs/auth.md`): members mint a five-minute single-use pairing code, the phone redeems it for a 90-day device credential, rotates it, and people list and revoke their devices (`/devices/pairing`, `/auth/pair/redeem`, `/devices`; migration `0039_device_pairing`).
- **Bring your own AI provider** (see `docs/llm-assist.md`): admins connect OpenRouter or any OpenAI-compatible endpoint per workspace (`/ai/provider`, `/ai/provider/test`, `/ai/usage`). Keys are sealed at rest and never returned, a monthly spend limit stops calls before they happen, and the endpoint obeys the webhook SSRF policy (migration `0040_ai_providers`).

- **Deploy lock and provenance** (`ops/deploy.sh`, U3): one deployer under `flock`, refuses a dirty tree, a target off `origin/main` or older than the running commit, runs the backup, builds api, web and mcp-server with `--profile mcp` and an `org.opencontainers.image.revision` label, health-checks all three, reads the labels back and logs commit, time and actor. See `docs/deploy.md`.
- **Browser sign-in for the CLI** (S1-U7, client half; see `docs/auth.md`): the web app now serves `/device`, where an admin or owner approves the code their terminal shows, choosing the workspace and read-only or read-write access. `tallyline connect` offers "In your browser" first and falls back to pasting a token; `tallyline connect --browser` works over SSH, `--paste` skips the choice. Signed-out visitors return to `/device` with the code after login.

### Fixed

- Oversized AI provider responses are rejected instead of resolving with an empty body.

## [2.0.0] — 2026-10-26

Major release: breaking ops, authorization, and naming changes (all listed
below), a Postgres-only stack, and the agent protocol. The npm packages
`@tallyline/mcp-server` and `@tallyline/cli` jump from 0.1.0 to 2.0.0 so
their versions match the product.

### Added (since 1.0.0, not itemised below)

- **Agent protocol** (#133, #155): typed agent sessions with ack and idle
  sweeps, and the complete Linear-teardown agent protocol (L1–L8) over the
  API and MCP.
- **Automated intake** (#149): fingerprinted ingest into ranked triage;
  duplicates fold into the newest live issue.
- **Plan import** (#140, #143, #150): core import with dry-run diff and
  layered dedupe, `import-plan` CLI, MCP tools, and the skill step.
- **Accounts and identity** (#90, #111): OAuth and org identity (global
  users, memberships, SSO, invites, admin surfaces); mailer, password reset,
  email verification, account deletion, and data export.
- **Usage metering and entitlements** (#108): `402 PLAN_LIMIT`, plus legal
  and trust pages.
- **Agent keys** (#141): revoke, rotate, and default expiry.
- **Projects, milestones, cycles** (#145, #146, #147): repos bound to
  projects with synced-issue backfill, issues linked to milestones, seeded
  `hitl` and `launch-blocker` labels, and weekly cycle auto-scheduling.
- **Webhook-event retention sweep** (#142) and a shared SSE event poller
  (#125).
- **Web**: core UI/UX overhaul (#103, #106, #109, #112), Silver Lining
  tokens and Appearance settings (#101), edge-state contract and typography
  (#135), DOM-rendered landing loop (#152), GitHub repo sync settings
  (#105), CSRF guard on every web write route (#144).

### Changed

- **License is now AGPL-3.0-only** (#114; was MIT).

### GlitchTip integration

#### Added

- **Device authorization (RFC 8628)** for the CLI: `POST /v1/auth/device/code`, `POST /v1/auth/device/token` and the approval routes under `/v1/workspaces/{ws}/device/{userCode}`. Migration `0037_device_authorizations`. API only; the web approval page and the CLI wiring follow.
- **Native GlitchTip webhook** (`POST /webhooks/glitchtip/:token`): GlitchTip's
  own alert payload becomes triage issues through the existing intake pipe,
  routed to a team by GlitchTip project name. Per-workspace secret (stored
  hashed, shown once), admin API at `/v1/workspaces/:ws/glitchtip`, a card in
  Settings > Integrations, and `ops/glitchtip-onboard.py` for one-command
  Pace/Wisp onboarding. See [docs/glitchtip.md](./docs/glitchtip.md). Needs
  migration `0033`.

#### Fixed

- Issue relation and suggestion routes were never mounted and returned 404.
- Workspace export and purge now cover `agent_activities`, `agent_sessions`,
  `intake_events`, `issue_relations`, `issue_suggestions`, `notifications`,
  `usage_daily` and `workflow_definitions`.

### Postgres-only stack

#### Changed (breaking — ops)

- **Redis removed.** Nothing consumed it (health ping only). The dev and
  self-host compose files, the e2e stack, CI service containers, and the
  `ioredis` dependency are gone. `REDIS_URL` is no longer read — remove it
  from your `.env` when convenient; a stale value is ignored, not an error.
- **`GET /health` shape**: `{ status, postgres, uptimeSeconds }` — the
  `redis` field is gone. Update any external healthcheck parsers.
- **Test guard**: `assertSafeTestEnv` now requires only `DATABASE_URL`.

### Go-live security hardening

#### Changed (breaking — authorization fixes from the permission matrix)

- **Agent keys can no longer approve or send back review items** (PLAN-056):
  `POST /issues/:key/review` and `PATCH` state `in_review → done|in_progress`
  return `403 FORBIDDEN_AGENT` for agent credentials. Agents can still move
  work into `in_review`. `tallyline done` with an agent key now stops at
  `in_review`.
- **Webhook endpoints are owner/admin only**: create, update, delete, list and
  delivery log return `403 FORBIDDEN_ROLE` to members and agent keys.
- **`GET /v1/workspaces/:ws/github/setup` is replaced by
  `POST /v1/workspaces/:ws/github/setup`** with body `{"installationId": n}`,
  owner/admin only. GitHub's Setup URL must be a web page that POSTs it.

#### Changed (defaults — review before upgrading an internet-facing install)

- **`AUTH_AUTO_JOIN_SINGLE_WORKSPACE` now defaults to off** (was on). Set `1`
  to keep the old open-membership behaviour.
- **`POST /v1/workspaces` is instance-admin only** unless
  `TALLYLINE_ALLOW_WORKSPACE_CREATE=1` (403 `FORBIDDEN_INSTANCE_ADMIN`).
- **Production refuses weak secrets**: with `NODE_ENV=production` the API
  will not start if `JWT_SECRET` is unset/empty/<32 chars/a known default, or
  if `AUTH_SECRET_KEY` (when set) is weak or equals `JWT_SECRET`.
- **Webhook and agent-dispatch URLs are SSRF-guarded** (private, loopback,
  link-local, CGNAT, ULA, metadata addresses rejected at save and at
  delivery; redirects not followed). Existing endpoints pointing at LAN hosts
  need `TALLYLINE_WEBHOOK_ALLOW_PRIVATE=1`.
- **Rate limiting counts anonymous traffic** per client IP
  (`RATE_LIMIT_ANON_PER_MIN`, default 120; `RATE_LIMIT_AUTH_PER_MIN`, default
  30 for login/bootstrap/invite/OAuth). Behind a proxy set `TRUSTED_PROXY=1`
  so the real client IP is read from `CF-Connecting-IP` / last
  `X-Forwarded-For` hop.

#### Fixed

- **Web app redirects no longer leak the upstream Host**: login/OAuth
  callback, logout, and the middleware login redirect previously built
  absolute `Location` targets from `req.url`. Behind a reverse proxy or
  tunnel that forwards an internal Host (e.g. `localhost:3100`) the browser
  was sent to an unreachable origin after signing in. All auth redirects now
  emit relative `Location` headers, which resolve against the public origin
  the browser actually requested — no config change needed for self-hosters.
- **`/my-issues` ignored the assignee filter** and listed every active
  issue; it now passes `assignee=<current user>` and sorts by priority.
- **Web surface uplift toward the issue-row contract** (DESIGN.md): list
  rows and board cards render priority glyphs, label chips, assignee
  avatars, and relative timestamps; issue detail gains a property rail
  with editable assignee, priority, labels, estimate, due date, cycle,
  and project, plus the rendered description body and a "filed by" agent
  attribution with the provenance glint on agent-created ids.

#### Added

- **Review-queue nav badge**: `GET /v1/workspaces/:ws/review-queue/count`
  returns the number of `in_review` issues carrying at least one dispatch —
  the sidebar Review row shows it as an accent badge, fetched server-side in
  the app layout.
- **Settings admin surfaces for labels, projects, and cycles**: three new
  pages under Settings tabs. Labels can be created (name + swatch),
  renamed/recolored inline, and deleted — backed by new
  `PATCH`/`DELETE /v1/workspaces/:ws/labels/:id` routes (previously the API
  had create/list only; delete detaches via `issue_labels` cascade).
  Projects get create + status transitions + delete; cycles get create
  (team, window, active flag), activate, complete, and delete.
- **Notification inbox** (`/notifications`, `g n`): a `notifications` table
  plus four workspace routes — `GET /notifications` (cursor-paginated,
  joined issue key/title), `GET /notifications/unread-count`,
  `POST /notifications/:id/read`, and `POST /notifications/read-all`.
  Fan-out materializes rows on human assignment, human `@mention` in
  comments (`@name`, `@name-surname`, `@namesurname` forms), `in_review`
  transitions to workspace owner/admin staff (excluding the actor), and
  dispatch failure to the issue's human creator. The surface is
  human-session-only: agent keys get `403 FORBIDDEN_AGENT`, and reading or
  marking another user's notification returns 404. Web: an Inbox sidebar
  entry with an unread-count badge fetched server-side in the app layout,
  a notification list page with mark-read/mark-all actions, and bridge
  routes under `/api/notifications*`.
- **Keyboard property pickers + command-mode verbs** on issue lists:
  `p`/`s`/`l`/`a` open inline pickers (priority digit-jump, legal state
  transitions, label multi-toggle via `labelIds` replace, human/agent
  assignee) applied to the focused row or multi-selection; `:` now accepts
  `priority`, `assign`/`unassign`, `label`, `due`, and `estimate`.
- **Remote MCP endpoint with OAuth 2.1** (PLAN-010/011): `POST /mcp`
  (Streamable HTTP) on the API host, Tallyline as its own authorization
  server (RFC 9728/8414, CIMD + DCR, PKCE S256, resource-bound tokens, rotating
  refresh tokens), a minimal consent page in the web app, and grant
  list/revoke endpoints. See `docs/mcp.md`.

- Security headers on web and API: CSP (nonce + `strict-dynamic` on the web
  app, `default-src 'none'` on the API), `frame-ancestors 'none'`,
  `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, HSTS on https requests; `x-powered-by`
  removed. The web root layout is now dynamically rendered (needed for nonces).
- `ops/backup.sh` / `ops/restore.sh`: encrypted (age) offsite Postgres backups
  to S3-compatible storage, with a documented, tested restore procedure
  (see docs/deploy.md).
- `RateStore` seam in the API rate limiter (in-memory default) for a future
  shared store.
- **Event-driven dispatch recipe** (U4): `docs/adapters.md` now documents
  transition-triggered dispatch over the existing seams — subscribe a webhook
  endpoint to `issue.state_changed`, filter in your consumer, trigger by
  assigning the issue to an agent or `@mention`ing it — including the
  loop-prevention rules. No in-app rule engine.
- **Dispatch acknowledgement timeout** (U3): a dispatch still `queued` after
  `DISPATCH_ACK_TIMEOUT_MS` (default 10 min — beyond the ~7.5 min webhook
  retry budget) is failed loudly on the issue thread and in the activity
  stream instead of hanging forever. `claimed` dispatches are never swept —
  claiming is the acknowledgement. `0` disables the sweep.
- **Board collapses empty columns by default** (U5): per DESIGN, empty board
  columns now render as slim labelled strips (dot + count, click to expand)
  instead of 300px of dead space — a typical board fits 1440px instead of
  overflowing at ~1760px. Columns force-expand during drags so drop zones
  stay full-size; any column can be pinned collapsed/expanded and the choice
  persists per device (`localStorage`).

### Renamed: docketry → Tallyline

The project is now **Tallyline**. In 2.0.0 the docketry compatibility layer
is gone: old env names, headers, token prefixes, cookies and config paths
are rejected. The notes below describe what 2.0.0 accepts and the upgrade
steps.

#### Migration notes

On upgrade from any docketry-named install:

1. Rename every `DOCKETRY_*` environment variable to `TALLYLINE_*`.
   **Old names are ignored, not warned about: a variable left as
   `DOCKETRY_*` behaves as if it were unset.**
2. Re-mint `dok_agt_*` agent keys and `dok_pat_*` PATs; they no longer
   validate. New credentials use `tly_agt_` / `tly_pat_` / `tly_wh_` /
   `tly_inv_`.
3. Expect every web session to sign out once (`dok_*` cookies are not read).
4. With the app stopped and while connected to another database (for
   example `postgres`; Postgres cannot rename the database you are
   connected to), rename it: `ALTER DATABASE docketry RENAME TO tallyline`. Then
   copy or re-point the old `docketry_*` Postgres volume to
   `tallyline-postgres`.

Details:

- **Packages and binaries** — `@docketry/*` → `@tallyline/*`; `docketry` →
  `tallyline`; `docketry-mcp` → `tallyline-mcp`; short alias `dok` → `tly`.
  `dok` remains as a deprecated bin that prints a one-line notice on stderr
  and then runs `tly`. Update agent/MCP configs to the new names.
- **HTTP headers** — outbound webhooks send `X-Tallyline-Signature`,
  `-Event`, `-Delivery`; passthrough MCP uses `x-tallyline-workspace` /
  `x-tallyline-api-url`. `X-Docketry-*` headers are neither sent nor
  accepted.
- **CLI config files** — `.tallyline.json`, `.tallyline/config.json` and
  `~/.config/tallyline/config.json`. `.docketry` paths are not read.
- **n8n / Composio** — node and credential types are now `Tallyline*`,
  Composio tool slugs `TALLYLINE_*`; workflows using the old node types need
  to be re-pointed.
- **Repository and storage** — the GitHub repository is
  `duketopceo/tallyline`, the default Postgres database is `tallyline`, and
  the only compose volume is `tallyline-postgres` (Redis was removed; see
  above). A leftover `docketry_redis` or `tallyline-redis` volume can be
  deleted.

#### Brand

- New mark and lockup in `assets/brand/` (four tally strokes struck by an
  azure line, with a dedicated 16px variant); the old docketry card logo
  is removed.

## [1.0.0] — 2026-10-10

First public release. docketry is a self-hostable, MIT-licensed,
agent-native issue tracker: humans and AI agents work the same board,
through the same system of record.

### Core

- Monorepo toolchain — pnpm workspaces + Turborepo, strict TypeScript
  throughout (#42)
- Issue data model — full lifecycle state machine (`triage` → `backlog` →
  `todo` → `in_progress` → `in_review` → `done`, plus `canceled`/
  `duplicate`), sub-issues, labels, projects, cycles, milestones (#43)
- Append-only event log — every mutation is an auditable event; powers
  the activity feed, insights, and webhooks (#43)
- REST API on Hono + Drizzle/Postgres with an OpenAPI spec (#44, #51)

### Web app

- App shell + dark canvas, single-workspace bootstrap (#46)
- Keyboard-first issue UX — list navigation, Cmd+K palette, quick-create,
  triage inbox, issue detail (#47)
- `?` keymap overlay + `:` command mode (`:state`, `:done`, `:assign`,
  `:comment`, `:open`) (#72)
- Kanban board with legal-move enforcement + keyboard drag (#74)
- Review queue — approve/send-back lane (#70)
- Insights — cycle time, burnup, velocity, actor throughput computed from
  the event log (#75)
- Roadmap — project milestones, start/target windows, timeline view (#79)

### Agents

- Agent identity model — `dok_agt_*` scoped keys, assignable agents,
  actor attribution on every event (#49)
- Human PATs (`dok_pat_*`) + short-lived session JWTs (#51, #52)
- MCP server — full issue/workflow tool surface on stdio and Streamable
  HTTP; hosted passthrough mode takes per-request
  `Authorization`/`x-docketry-workspace` headers for multi-tenant
  endpoints (Klavis Strata path documented) (#54, #86)
- `docketry` CLI — ready/next/claim/done/comment/create, machine-stable
  exit codes (#53)
- Dispatch pipeline — assign/@mention triggers, local CLI adapter,
  external harness delivery with signed webhooks, session timeline (#64,
  #67, #68, #69)
- Agent onboarding pack — `SKILL.md` board rules + harness setup (#57)

### Integrations

- GitHub App — webhook receiver, repo linkage, branch/PR loops,
  bidirectional issue sync (state/comments/labels, conflict events,
  loop prevention) (#62, #63, #77)
- Slack — `/docket` intake, emoji reaction capture, bidirectional thread
  mirroring, signed webhooks, atomic per-thread idempotency (#78)
- Signed outbound webhooks — endpoint CRUD, delivery log, retry sweeper
  (#65)
- Signed inbound webhook endpoints for external triggers (#69)
- Importers — GitHub issues + Linear CSV, idempotent (#66)
- n8n community node + signed webhook trigger (#83)
- Composio toolkit — `DOCKETRY_*` tools via `experimental_createTool`
  (#84)
- OpenRouter-first LLM assist — summarize, triage suggest, duplicate
  detect; opt-in and kill-switched off by default (#76)

### Self-hosting & ops

- One-command Docker Compose stack — postgres + redis (internal only) +
  api (migrations on boot) + web, board in under ten minutes (#85)
- Full deploy guide — env reference, Cloudflare Tunnel and Railway
  paths, upgrades, backup/restore, hardening (#85)
- Performance budgets enforced in CI — 10k-issue fixture, p50/p95 API
  bench, bundle gate, browser vitals, axe a11y suite (#82)
- Security review — Slack intake atomic-claim fix, webhook signature
  coverage, checklist documented (#82)

### Notes

- MIT-licensed. Self-hosting is the primary deployment path; a hosted
  SaaS is out of scope for this repo.
- Postgres 17 + Redis 7 + Node 22. Migrations are forward-only and run
  automatically on API boot.
- Agent-attribution: portions of this codebase were implemented by AI
  agents (Devin, Cursor, Codex) under human direction, per the repo's
  disclosure conventions.

[1.0.0]: https://github.com/duketopceo/tallyline/releases/tag/v1.0.0
