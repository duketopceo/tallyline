---
title: Self-hosted Linear — polished CLI, zero-skill setup, AI providers, iOS client (staged)
type: feat
date: 2026-10-28
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
origin: docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md
execution: code
supersedes_in_part: docs/plans/2026-10-12-2107-feat-ios-app-plan.md
---

# Self-hosted Linear: polished CLI, zero-skill setup, AI providers, iOS client

## Goal Capsule

- **Objective:** A non-technical owner can stand up their own Tallyline, connect an
  AI provider and their coding agents, and work the board from an iPhone, on a
  server they control. Tallyline stays positioned as a serious Linear replacement.
- **Means:** Seven stages, each independently shippable and verifiable. Stage 1
  (CLI polish) needs no server change and ships first. Stages 1 to 3 do not depend
  on the iOS work. Stage 4 is the server groundwork the iOS app needs. Stages 5 to 7
  are the app.
- **Authority hierarchy:** Requirements in `origin:` > this plan > ROADMAP.md >
  `DESIGN.md` visual contract > the 2026-10-12 iOS plan (carried forward where this
  plan says so) > generic iOS conventions.
- **Stop conditions:** Stop and ask Luke before: any App Store Connect upload,
  any TestFlight build leaving the internal group, creating the App ID or app
  record, enabling the push relay in production, any paid model call outside a
  test cap, submitting OpenAI or Apple forms, and any production deploy outside
  the U3 deploy procedure. Never place credentials in the repo, in CLI arguments,
  or in logs.
- **Execution profile:** `ce-work` one unit at a time, one PR per unit, PRs to
  `main`, admin-merge only when CI is green and review is clean (Luke's standing
  rule). Conventional commit titles. No co-author trailers.

## Product Contract

See the origin requirements for R1 to R26, decisions D1 to D15, the acceptance
examples AE1 to AE5, the CLI design screens, and the open questions. This plan
does not restate them. Where a unit below names `R#` or `D#`, it means those.

## Current state (verified 2026-10-28, `main` at `acd20dd`)

| Fact | Evidence |
|---|---|
| `apps/ios` does not exist | `ls apps` shows `api`, `mcp-server`, `web` |
| API rejects private-use redirect schemes, so the old iOS U1 is still open | `apps/api/src/services/mcp-oauth.ts:155` `validRedirectUri` allows only https and loopback http |
| OAuth 2.1 server with DCR, PKCE, revoke is live; loopback redirects work for CLIs | `apps/api/src/routes/mcp-oauth.ts` |
| Remote MCP at `/mcp` with OAuth | `docs/mcp.md` |
| Sign-in providers GitHub, Google, OIDC; DB-stored secrets AES-256-GCM via `AUTH_SECRET_KEY` | `docs/auth.md`, `docs/deploy.md` |
| LLM seam is OpenAI-style, OpenRouter default, env-configured, off without a key | `docs/llm-assist.md`, `apps/api/src/services/llm.ts` |
| Dispatch adapters: `local`, `claude-code`, `codex`, `opencode`, `webhook`; `tallyline work` local runner | `docs/adapters.md` |
| Notifications are inbox rows only; no device tokens, no APNs | `apps/api/src/services/notifications.ts`; grep for `apns` and `device_token` in `apps/api/src` finds nothing |
| Web app is installable (manifest) with roadmap pulse and push view | `apps/web/app/manifest.ts`, #167, #173 |
| CLI is TypeScript, zero runtime deps (esbuild bundle), `--json` and stable exit codes, a colour layer, `init`, `work` | `tools/cli/src/*`, `tools/cli/package.json` |
| Settings routes today: account, agents, appearance, cycles, dev-inbox, integrations, invites, labels, members, projects, providers (sign-in), tokens, usage, workspace | `apps/web/app/(app)/settings/` |
| Self-host is a clone plus hand-built `.env` plus compose with about 40 env vars | `README.md`, `docker-compose.selfhost.yml` |
| Brand: tally-strike mark, azure accent `#3ea1f7` dark and `#0b66cc` light | `assets/brand/README.md`, `DESIGN.md` |
| `@clack/prompts` exists on npm at 1.8.1 (checked with `npm info`) | registry check 2026-10-28 |

## Naming

- **AI provider** = what powers Tallyline-run agent actions (OpenRouter, ChatGPT
  plan, OpenAI-compatible). **Sign-in provider** = GitHub, Google, OIDC for humans
  (the existing `/settings/providers`). The new web page is `/settings/ai`. The
  two are never both called just "provider" in UI copy.
- **Coding agent** = Claude Code, Codex, Cursor, opencode connecting as a client.
- **Agent action** = a Tallyline-run model call that returns a suggestion.
- **Device** = a paired phone session.

## Key Technical Decisions

- **KTD1 — CLI stays TypeScript; add a prompt/spinner library, bundled.** Use
  `@clack/prompts` (grouped intro/outro, select, confirm, spinner, note; widely
  used in scaffolding CLIs) for interaction and the existing `pretty.ts` layer
  for state glyphs and tint. esbuild bundles it, so the published package keeps
  zero runtime dependencies. Pin the version and verify it on the registry before
  install (luke-agents review checklist). Fallback if it fights our output
  contract: a small in-repo prompt kit (about 300 lines). Rejected: Go rewrite with
  cobra, fang, lipgloss and huh like OmaSeal, because it forks the toolchain and
  loses shared types.
- **KTD2 — Decoration is a presentation layer on top of an unchanged data layer.**
  Every command returns a typed result; a renderer turns it into pretty output on a
  TTY and today's plain output otherwise. A golden-file test pins the non-TTY and
  `--json` output of every existing command before any rendering change lands
  (OmaSeal's `cli_stable_test` pattern).
- **KTD3 — Global profile plus keychain.** Profile file at the XDG config path
  (`tallyline/profile.json`), holding server, workspace and agent name only.
  Tokens go to macOS Keychain (`security`) or libsecret (`secret-tool`) when found,
  OmaSeal when present on Omarchy, else a 0600 file with a doctor warning. Existing
  `.tallyline/config.json` repo-local config and the three env vars keep working
  and win over the profile.
- **KTD4 — CLI login uses the OAuth server that already exists.** Loopback
  redirect, auth code plus PKCE (RFC 8252), DCR once per server. Headless fallback
  is "paste a personal token from Settings → Tokens" with a deep link. No new
  server endpoint in Stage 1.
- **KTD5 — Setup stack is generated, not templated by hand.** `tallyline setup`
  writes a compose file and an env file under `~/.tallyline/` from an embedded
  template, generating all secrets (`JWT_SECRET`, `AUTH_SECRET_KEY`, DB password,
  the U2 backup key) itself. The user never sees them except through `config`
  and the backup-key save screen.
- **KTD6 — AI provider is a first-class server concept.** New table of per-
  workspace providers: kind, display name, encrypted credential blob, model
  allowlist, monthly cap, per-action ceiling, status. A ledger table records each
  call's provider, model, tokens, cost, actor and issue. Reuse the AES-GCM
  sealing already used for sign-in provider secrets. The existing `LLMProvider`
  interface in `services/llm.ts` stays the seam; each provider kind is an
  implementation. `TALLYLINE_LLM_*` env stays as an expert override and is shown
  in the UI as "set by environment".
- **KTD7 — Suggestions, not writes.** Agent actions write rows into the existing
  suggestions mechanism (U25, landed in #155; **not re-verified per unit**, confirm
  in S3-U4) tagged with the agent identity, and a human accepts. Review approval
  stays human-only (existing 403 rules).
- **KTD8 — ChatGPT plan is a spike-gated provider.** Implementation follows
  OpenAI's documented Codex app-server pattern (OAuth access token as bearer to
  the Responses API with a ChatGPT-plan provider, `store:false`, `stream:true`),
  fetched fresh in the spike because the page says it is a preview. If Tallyline
  is not accepted as a participating tool, S3-U5 is dropped and the UI never shows
  the option.
- **KTD9 — Push goes through a content-free relay.** Server to relay carries only
  `{deviceToken, serverId, eventId, kind}` signed with a per-server key; relay to
  APNs sends an alert with generic text plus `mutable-content`; the app's
  notification service extension fetches details from the user's own server with
  the device session. Relay stores nothing durable but token-to-server routing for
  rate limiting. Open source in `apps/push-relay`.
- **KTD10 — Pairing is a one-time code, not a password.** Logged-in web session
  (or CLI) mints a 5-minute single-use pairing code bound to the user and
  workspace; QR content is `tallyline://pair?s=<server>&c=<code>`; the app
  redeems it for an access plus refresh token pair stored in Keychain, labelled
  with the device name, listed and revocable in Settings → Devices, audited as
  `device_paired` and `device_revoked`. Rate limited per IP and per user. Server
  URL sign-in through the existing OAuth flow remains as the fallback (carried from
  the 2026-10-12 plan, KTD2).
- **KTD11 — iOS data layer.** Typed client generated from `/v1/openapi.json`
  (carried from the old KTD3, with its fallback). A repository layer reads
  through a local store first. Store choice (SwiftData vs SQLite via GRDB) is a
  one-day spike in S6-U1; default SwiftData. Writes go through an outbox with
  client-generated idempotency keys; server needs idempotency support (S4-U4).
- **KTD12 — Sync is delta-based.** Server adds `updatedSince` cursors to the list
  endpoints the app caches, rather than the app refetching everything. The roadmap
  defers "delta sync" with a revisit trigger; this plan is that trigger firing.
- **KTD13 — Build and sign on the Mac mini; develop with xtool.** Shipping builds
  come from the mini over `ssh mini` (macOS Xcode, `xcodegen`, App Store Connect
  API key already on the mini). `xtool` on omarchy-max stays the fast inner-loop
  install to a registered phone (xtool 1.21.0 verified on omarchy-max, not present
  on the mini). The old plan's "no Xcode needed" stance is dropped for anything
  that ships.
- **KTD14 — The iOS project mirrors `kate-ios`.** SwiftPM package for the app
  code plus an `xcodegen` `project.yml` for the shipping target, a
  `scripts/testflight.sh` modelled on Kate's (archive, export, dSYM keep, upload),
  build numbers from UTC timestamp. Kate's repo is the reference, not a dependency
  (read-only inspection 2026-10-28).

## Build and TestFlight pipeline

### Verified (read-only, 2026-10-28, run from omarchy-max)

| Check | Result |
|---|---|
| `ssh mini` from omarchy-max | Works (host alias `mini` and `mac-mini`, Tailscale name). Host `M1-Mac-Mini.local`, user `lukekimball`, up 17 days |
| Mini OS and Xcode | macOS 27.2, Xcode 27.1 (build 27A9275) |
| Tools on mini | `xcodegen` at `/opt/homebrew/bin`; `fastlane` absent; `xtool` absent |
| Signing identities in the login keychain | An Apple Distribution identity and two Apple Development identities listed as valid |
| Existing pipeline | `~/bin/testflight kate|cairn|all` on omarchy-max runs `ssh -t mac-mini "/opt/homebrew/bin/release …"`; `release` on the mini resets clean clones under `~/release/`, copies a gitignored per-app `Config.swift` from `~/release/config/`, sources `~/release/testflight.env` (key id, issuer id, key path, team id; the `.p8` stays in `~/.appstoreconnect`), unlocks the login keychain if needed, runs the app's `scripts/testflight.sh`, and greps the log for upload success |
| Pipeline scope | `release` has `kate` and `cairn` cases only. No Tallyline entry exists |
| Kate's `scripts/testflight.sh` | Uses `xcodegen`, `xcodebuild archive -allowProvisioningUpdates` with the API key, exports an IPA, keeps dSYMs, uploads; build number `date -u +%Y%m%d%H%M%S` |
| xtool on omarchy-max | 1.21.0 |

I did not run any build, signing, keychain unlock, or upload.

### Assumed (verify in S5-U1 before relying on them)

- Xcode 27.1 on the mini is a release Xcode acceptable for TestFlight (Kate's
  README warns against RC SDKs).
- The App Store Connect API key has App Manager or Admin access, enough to create
  an app record and upload builds.
- A Tallyline App ID and App Store Connect app record do not exist yet.
- The mini's keychain unlock works non-interactively over ssh or needs Luke at the
  console on build days (the `release` script exits with a message if locked).
- Network egress from the mini to App Store Connect works (Kate and Cairn shipped
  from it, per the script, but no run was observed).

### Target pipeline (after S5-U1)

1. `~/bin/testflight tallyline` on omarchy-max (new case added to `release` on the mini).
2. Mini resets `~/release/tallyline` to `origin/main`, copies `tallyline.Config.swift` (default server, relay URL; no secrets), runs `apps/ios/scripts/testflight.sh`.
3. Script: `swift test`, `xcodegen generate`, `xcodebuild archive`, export, keep dSYMs, export and upload with the same tooling Kate's script uses (confirm the exact command in S5-U1; Kate's script is the working reference).
4. Build lands in the internal TestFlight group. A TestFlight status check (App Store Connect API read) reports processing state back to the tallyline board as a comment on the stage ticket.

## Stages

Each stage is shippable alone. "Ships" says what a user can do at the end.

| Stage | Name | Ships | Depends on |
|---|---|---|---|
| S1 | Polished CLI | A branded, friendly `tallyline` with home screen, doctor, config, login | none |
| S2 | Zero-skill install and onboarding | One command or one click to a running server; first-run checklist | S1 |
| S3 | AI providers and agent connection | OpenRouter and compatible providers, suggestions, one-flow coding-agent connect | S2 (onboarding step); S1 (CLI) |
| S4 | Mobile server groundwork | Pairing, device registry, push relay, delta sync, idempotent writes, redirect schemes | none (parallel with S1 to S3) |
| S5 | iOS v1 to TestFlight | Core app on Luke's phone via TestFlight | S4, pipeline |
| S6 | iOS full quality | Offline, push, widgets, share, intents, accessibility | S5, S4 |
| S7 | App Store | External beta and public listing | S6, Luke decisions |

Suggested order given one builder: S1, S4, S2, S5 in parallel with S3, then S6, S7.
S1 is first because it is independent, visible, and Luke asked for it explicitly.

---

### Stage S1 — Polished CLI

**Stage goal:** The CLI looks and feels like a modern product CLI and is safe for
less technical people, with the machine contract untouched.
**Ships:** `tallyline` home, grouped help, `doctor`, `config`, `connect`, brand art.
**Stage verification:** golden outputs for all existing commands unchanged
non-TTY; new screens match the design mockups in the origin doc; demo GIF
recorded; `pnpm --filter @tallyline/cli test lint typecheck` green.

#### S1-U1. UI kit and error catalog
- **Goal:** One place that renders status lines, tables, steps, spinners, prompts, banner and plain-language errors.
- **Requirements:** R19, R22, R24; KTD1, KTD2.
- **Files:** `tools/cli/src/ui/` (new: `theme.ts`, `banner.ts`, `status.ts`, `spinner.ts`, `prompt.ts`, `errors.ts`, `glossary.ts`), `tools/cli/src/pretty.ts` (reuse), `tools/cli/package.json` (dependency pinned and bundled), `tools/cli/src/ui/*.test.ts`.
- **Approach:** Add `@clack/prompts` pinned, bundled by esbuild. Theme maps azure accent and the four-status palette to 256-colour and truecolour with graceful fallback; glyphs paired with colour. Decoration gated on TTY, `NO_COLOR`, `TERM=dumb`, `--json`, `--no-color`. Error catalog: code, plain message, cause, fix, optional auto-fix id. API errors (`{error:{code,message}}`) map through it.
- **Test scenarios:** non-TTY renders byte-identical to today for a sample of commands; `NO_COLOR` strips colour but keeps glyphs; every catalog entry has message, fix and a unique code; spinner never writes control codes when piped.
- **Verification:** unit tests green; golden-file harness exists and passes against pre-change output.

#### S1-U2. Home screen, grouped help, aliases
- **Goal:** R19 home screen; help grouped Work / Set up / Agents / Health.
- **Files:** `tools/cli/src/commands.ts`, `tools/cli/src/index.ts`, `tools/cli/src/cli.ts`, `tools/cli/src/ui/home.ts`.
- **Approach:** No-arg on a TTY runs home (whoami, review and triage counts, in-progress list, three next commands); off a TTY prints today's help. Hidden aliases keep every old name for one release.
- **Test scenarios:** TTY and non-TTY snapshots; unauthenticated home shows "not connected, run tallyline connect"; slow server degrades to a spinner then a friendly timeout message.
- **Verification:** snapshot tests; manual terminal pass at 80 and 120 columns.

#### S1-U3. Global profile, keychain, `config`
- **Goal:** R23.
- **Files:** `tools/cli/src/config.ts`, `tools/cli/src/config.test.ts`, `tools/cli/src/secrets.ts` (new), `tools/cli/src/ui/config-tui.ts`.
- **Approach:** KTD3. `config` with no args is a guided editor (server, workspace, default agent name); `config get|set|path` for scripts. Precedence: flags, env, repo-local, profile. Token store adapters for macOS Keychain, `secret-tool`, OmaSeal, 0600 file.
- **Test scenarios:** precedence matrix; 0600 enforced and a doctor warning when falling back; a token never appears in `ps`, logs or `--json`; migrating a user who only has env vars changes nothing.
- **Verification:** tests plus a manual keychain round-trip on macOS and Linux.

#### S1-U4. `connect` (login) and `status`
- **Goal:** "Sign in" without env vars or minted keys.
- **Files:** `tools/cli/src/login.ts` (new), `tools/cli/src/ui/connect.ts`.
- **Approach:** KTD4. Ask for server address (default Tallyline Cloud), discover, DCR, open browser to authorize with loopback redirect, store tokens, pick workspace. Headless: print a link to Settings → Tokens and prompt for the token. `status` shows server, user, workspace, version.
- **Test scenarios:** stubbed OAuth server happy path; denied consent; wrong server address gives the plain-language error; expired refresh signs out cleanly; headless paste path.
- **Verification:** live sign-in against `api.tallyline.app`.

#### S1-U5. `doctor` and `--fix`
- **Goal:** R21, AE5.
- **Files:** `tools/cli/src/doctor/` (new: `checks.ts`, `fixes.ts`, `render.ts`), tests.
- **Approach:** Concurrent checks grouped Your server / Your connections / This computer, each returning `{ok|warn|fail, plain message, fix}`. Client-side checks: reachability, TLS, version skew, token validity, keychain, PATH, update available. Server checks use existing endpoints now (`/health`, whoami, list agents) and the S2-U3 status endpoint when present. `--json` emits the same shape as OmaSeal's doctor. `--fix` runs only safe fixes and asks first.
- **Test scenarios:** each check fails independently with its message; offline machine; `--json` schema stable; `--fix` never runs a destructive action without confirmation.
- **Verification:** tests; manual run against a broken local stack.

#### S1-U6. Art, demo and CLI design doc
- **Goal:** R24.
- **Files:** `docs/design/cli.md` (new, from the origin doc's CLI design section plus the glossary and error catalog table), `tools/cli/README.md`, `tools/cli/docs/demo/` (vhs tape, demo env script, GIF), `assets/brand/` (terminal mark proposal).
- **Approach:** Verify the terminal mark against `assets/brand/mark.svg`; record the demo against a throwaway server with fake data (OmaSeal's `demo-env.sh` pattern); update README, drop the "needs three env vars" line.
- **Verification:** GIF renders in the README; Luke signs off the mark.

---

### Stage S2 — Zero-skill install and onboarding

**Stage goal:** AE1.
**Ships:** a person with a Mac and no terminal experience gets a running, reachable server.
**Stage verification:** a clean macOS VM or machine, no Docker, no clone: install line to ready screen; repeat on Ubuntu; time it; usability pass with one non-technical person (not an agent).

#### S2-U1. `tallyline setup` (local wizard)
- **Requirements:** R1, R3, R20; KTD5.
- **Files:** `tools/cli/src/setup/` (new), `tools/cli/src/setup/compose.template.yml`, `tools/cli/src/setup/preflight.ts`, tests.
- **Approach:** Preflight (OS, memory, disk, ports, Docker presence and running); plain-language offer to install Docker Desktop via Homebrew or the official installer link (never silently); generate secrets; write `~/.tallyline/`; `docker compose up -d`; wait on `/health` with a spinner and a friendly timeout; open the browser to `/bootstrap`; print the ready screen with QR (S4-U2 when available) and next steps. Re-runnable and idempotent: detects an existing install and offers repair or upgrade instead of reinstalling. Never deletes volumes without a typed confirmation.
- **Test scenarios:** Docker missing, Docker installed but stopped, port 3100 in use, low disk, interrupted mid-run then resumed, second run on an existing install; secrets never printed except the backup key screen.
- **Verification:** AE1 on clean machines.

#### S2-U2. Installer, Homebrew, npx, binaries
- **Requirements:** R25.
- **Files:** `tools/install/install.sh` (new, pinned version plus embedded checksum per OmaSeal), `.github/workflows/publish.yml` (extend), packaging notes in `docs/releasing.md`.
- **Approach:** One-line installer that verifies a pinned checksum, never follows "latest". Single-file binaries via Node single-executable or bun compile (spike one day, keep whichever passes smoke on macOS arm64 and x64, Linux x64 and arm64). Homebrew tap formula. `npx @tallyline/cli setup` documented as the alternate. Windows: WSL guidance page.
- **Test scenarios:** checksum mismatch aborts; dry run; upgrade in place; PATH advice printed in plain words.
- **Verification:** install smoke in a clean container and on a Mac.

#### S2-U3. Server status endpoint and web first-run checklist
- **Requirements:** R2, R4.
- **Files:** `apps/api/src/routes/system.ts` (new `GET /v1/workspaces/:ws/system/status`, admin only), `apps/web/app/(app)/welcome/`, `apps/web/components/welcome-checklist.tsx`, settings pages for domain, email, backups surfaced read-only first.
- **Approach:** Status returns version, database health, last backup age (from the U2 backup marker, when configured), configured sign-in and AI providers, email configured, public URL sanity. Checklist reads it and the workspace state; steps link to the right setting. Skippable, resumable, dismissible, emits an event. Uses the existing UX rules (empty states with what, why, next).
- **Test scenarios:** member without admin sees a reduced list; backups not configured shows an attention state, not a failure; status never leaks secrets.
- **Verification:** API and component tests; screenshot per DESIGN.md in the PR.

#### S2-U4. One-click deploy template
- **Requirements:** R1, D9.
- **Files:** `docs/deploy.md` (new section), `deploy/railway/` template config, README button.
- **Approach:** Railway template provisioning Postgres, API and web with generated secrets, mapped to the same env contract. Verify against Railway's current template mechanism at build time (docs read then, not now).
- **Verification:** deploy from the button into a scratch project and reach `/bootstrap`; tear down.

#### S2-U5. `start`, `stop`, `status`, `update`, `backup`
- **Requirements:** R20.
- **Files:** `tools/cli/src/ops/`.
- **Approach:** Thin guided wrappers over compose and the existing backup scripts (`ops/`, U2). `backup` shows last backup, runs one now, explains the key. `update` pulls the pinned release, backs up first, migrates, health-checks, rolls back on failure with a plain message. Depends on U2 backups being operational for the restore-test claim in `doctor`.
- **Verification:** update from 2.0.0 to the next tag on a scratch install; forced failure rolls back.

#### S2-U6. Reachability guide (spike)
- **Goal:** Let the phone reach a home server.
- **Approach:** Evaluate Cloudflare Tunnel and Tailscale as guided options inside `setup`, with plain-language pros and cons; ship the one that works in under five clicks. Spike output is a decision note plus, if clean, a wizard step.

---

### Stage S3 — AI providers and agent connection

**Stage goal:** AE2.
**Ships:** admin connects OpenRouter in one click; agent actions produce suggestions; coding agents connect in one flow.
**Stage verification:** end-to-end against a real OpenRouter test key with a low cap; agent write boundaries unchanged (existing agent-scope tests stay green).

#### S3-U1. Provider spike (read and prototype only)
- **Approach:** (1) OpenRouter PKCE flow including the headless paste-code mode, against a throwaway account. (2) Hermes: what interface it exposes (confirm with Luke which Hermes). (3) ChatGPT plan: read OpenAI's current "Sign in with ChatGPT" token-sharing docs end to end, list partner prerequisites, record whether Tallyline qualifies. Output: `docs/research/2026-10-ai-providers-spike.md`, decision on S3-U5. No production calls, no forms submitted.
- **Verification:** doc merged; Luke answers open questions 4 and 5 or defaults apply.

#### S3-U2. AI provider model, storage, ledger
- **Requirements:** R7, R8; KTD6.
- **Files:** `apps/api/src/db/schema.ts` and a migration (providers, ledger), `apps/api/src/services/ai-providers.ts`, `apps/api/src/routes/ai-providers.ts`, tests, OpenAPI, `docs/llm-assist.md`.
- **Approach:** Admin-only CRUD; secrets sealed; never returned; events `ai_provider_connected|changed|disconnected`; spend ledger and cap enforcement before each call; env config surfaces as a read-only "from environment" provider.
- **Test scenarios:** member and agent keys get 403; secret never in any response, event or log; cap reached returns a typed error the UI renders in plain words; env provider coexists.
- **Verification:** `pnpm --filter @tallyline/api test`; migration applies on a copy of prod (never prod directly).

#### S3-U3. Connect OpenRouter and OpenAI-compatible
- **Requirements:** R5, AE2.
- **Files:** `apps/web/app/(app)/settings/ai/`, `apps/api/src/services/openrouter-oauth.ts`, `tools/cli/src/agent/connect-provider.ts`.
- **Approach:** Web: Connect OpenRouter does PKCE with the API as the redirect target (HTTPS callback; documented port rules), stores the returned key sealed, asks for the cap, runs a test call. CLI: browser flow, or headless paste-code mode. Compatible endpoint form: base URL, optional key, test button; covers Hermes and local models. Model picker with a safe default.
- **Test scenarios:** denied authorization; expired code; callback state mismatch; test call failure shows reason; private-address endpoints follow the same SSRF rules as sign-in providers (https and public DNS, with an explicit opt-in flag for home servers).
- **Verification:** live OpenRouter connect on a scratch workspace; screenshots.

#### S3-U4. Agent actions v1
- **Requirements:** R8, D7; KTD7.
- **Files:** `apps/api/src/services/assist.ts` (move onto providers), new actions in `apps/api/src/services/agent-actions/`, web buttons, MCP tools.
- **Approach:** Re-home summarize, triage-suggest and dup-check onto the provider seam. Add break-down into sub-issues, status-update draft (extends `project-update-draft.ts` with an optional model polish), PR-brief draft, inbox answer. All return suggestions with agent identity and model recorded. Per-action ceiling and cap enforced. Confirm during this unit that the suggestions mechanism from U25 is present and fit; if not, the unit adds the minimum.
- **Test scenarios:** nothing is written until accepted; agent identity shown on the glint; cap pauses actions; provider failure degrades to a plain message without breaking the page.
- **Verification:** API tests with a stub provider; live test with a capped key.

#### S3-U5. ChatGPT-plan provider (conditional)
- **Goal:** D4.
- **Approach:** Only if S3-U1 says go: implement the documented token-sharing flow, token refresh, weekly limit surfaced, preview limits in copy. Drop the unit and its UI if No.
- **Verification:** live sign-in on a test ChatGPT account, one capped action succeeds.

#### S3-U6. Connect a coding agent (one flow)
- **Requirements:** R9, R10; D5.
- **Files:** `apps/web/app/(app)/settings/agents/connect/`, `tools/cli/src/agent/connect-agent.ts`, `docs/agents.md`.
- **Approach:** Pick Claude Code, Codex, Cursor or opencode. Detect installed harnesses on the machine for the CLI path, write or merge the MCP entry (preserve other servers, like OmaSeal's `mcp install`), using the OAuth `/mcp` endpoint so no key is pasted; verify the agent appears (or a test call succeeds). Config paths and formats per harness are verified at build time, not assumed now (the existing `docs/agents.md` lists Claude Code `.mcp.json`, Cursor `~/.cursor/mcp.json`, Codex `~/.codex/config.toml`, opencode `opencode.json`).
- **Test scenarios:** existing config preserved; undo removes only our entry; harness not installed gives plain instructions; scopes default read plus write, review never granted.
- **Verification:** each harness on omarchy-max against a scratch workspace.

#### S3-U7. Settings → AI and onboarding step
- **Files:** settings page and the S2-U3 checklist step.
- **Verification:** a11y pass, empty states, screenshots.

---

### Stage S4 — Mobile server groundwork

**Stage goal:** The server can serve a phone properly.
**Ships:** QR pairing, devices screen, redirect-scheme support, delta sync, idempotent writes, a working push relay (disabled in prod until approved).
**Stage verification:** API tests; OpenAPI regenerates cleanly; relay tested against Apple's sandbox with a real device token on a test build.

#### S4-U1. Native redirect schemes
- **Carried from the old plan U1.** `validRedirectUri` and `validateRedirectList` accept RFC 8252 section 7.1 private-use schemes; reject `http` non-loopback, `javascript`, `data`, `file`, fragments. Tests as in the old plan. Changelog note.

#### S4-U2. QR pairing and Devices
- **Requirements:** R13 prerequisite, R18, D13; KTD10.
- **Files:** `apps/api/src/routes/devices.ts`, `apps/api/src/services/devices.ts`, schema and migration, `apps/web/app/(app)/settings/devices/`, `tools/cli/src/pair.ts`.
- **Approach:** Mint code (web or CLI), redeem endpoint (public, rate limited), device sessions with refresh rotation, list and revoke, events. QR rendered in web and terminal.
- **Test scenarios:** code single-use; expires at 5 minutes; wrong or replayed code uniform error; revoked device 401s on its next call; brute force throttled; agent keys cannot mint codes.
- **Verification:** API tests plus a manual redeem with curl.

#### S4-U3. Push relay and device tokens
- **Requirements:** R13; D12; KTD9.
- **Files:** `apps/push-relay/` (new), `apps/api/src/services/push.ts`, schema (device push tokens, per-kind preferences), `docs/push.md`.
- **Approach:** Server enqueues a minimal ping on the existing notification fan-out; relay validates the per-server signature and forwards to APNs with token-based auth (key held only by the relay). Self-hosted servers register with the relay at pairing time. Off unless configured.
- **Test scenarios:** payload contains no issue text; unknown or revoked device dropped; relay down does not block API writes; rate limits.
- **Verification:** sandbox push to a test build. **Stop:** enabling the production relay and its Apple key needs Luke.

#### S4-U4. API gaps for mobile
- **Requirements:** R12; KTD11, KTD12.
- **Approach:** (1) `updatedSince` cursors on issues, comments, projects, cycles, labels, notifications. (2) `Idempotency-Key` on mutating issue and comment routes. (3) OpenAPI available to the generator without a user token (or a documented fetch). (4) Review-queue and inbox shapes confirmed for mobile. (5) Compact "mobile summary" endpoint only if list calls prove too chatty in S5.
- **Test scenarios:** replayed key returns the original result; deleted rows appear as tombstones in delta reads; pagination stable.
- **Verification:** API tests; performance budget noted in `docs/perf-budgets.md`.

---

### Stage S5 — iOS v1 to TestFlight

**Stage goal:** Luke runs Tallyline on his phone from a TestFlight build.
**Ships:** QR or URL sign-in, workspace switcher, triage, my issues, issue detail with comments, create and edit, board, projects, cycles, labels, roadmap, search, inbox, review queue.
**Stage verification:** `swift test` green on the mini; per-unit smoke on a device; live acceptance (sign-in, triage, comment, state change, approve a review, see it on web).

#### S5-U1. Pipeline and Apple setup (needs Luke)
- **Requirements:** R26; KTD13, KTD14.
- **Approach:** Verify the assumptions list above. Confirm bundle ID and name availability (open question 3). Draft the exact App ID and app-record steps; creating either in Apple's console is Luke's go. Add a `tallyline` case to the mini's `release` script and a `tallyline.Config.swift` under `~/release/config/`, a `testflight tallyline` path on omarchy-max (already generic). Prove it with a hello-world build before any real code ships. Report build and upload logs without secrets.
- **Verification:** a trivial build processed by TestFlight and installable. **Stop:** upload only with Luke's explicit go.

#### S5-U2. Scaffold `apps/ios`
- **Files:** `apps/ios/` (SwiftPM package, `project.yml`, `scripts/testflight.sh`, `Resources/`, `PrivacyInfo.xcprivacy`, README), `.gitignore`, repo README line.
- **Approach:** Mirror `kate-ios`. iOS 17, Swift 6, zero UI dependencies; only `swift-openapi-generator` and runtime if it resolves. Not part of the pnpm workspace.
- **Verification:** builds on the mini; `swift test` runs.

#### S5-U3. Auth and pairing
- **Carried and extended from old U3.** Camera QR scan, URL sign-in via ASWebAuthenticationSession plus PKCE, Keychain tokens, single-flight refresh, sign-out wipes cache.
- **Test scenarios:** the old plan's list plus: pairing code redeem, expired code message, revoked device returns to the picker.

#### S5-U4. Generated API client
- **Carried from old U4** with the delta-cursor and idempotency additions.

#### S5-U5. Issue loop
- **Carried from old U5.** Optimistic updates with revert. Outbox hooks are stubbed here and completed in S6-U1.

#### S5-U6. Board parity, search, inbox, review queue
- **Carried from old U6**, plus search, inbox and the review queue (approve or send back, human only, with a confirmation). Roadmap view includes the roadmap-pulse progress rings read from the summary endpoint.

#### S5-U7. Silver Lining theme and iPad
- **Carried from old U7:** generated `Theme.swift`, dark and light, keyboard shortcuts, split view.

#### S5-U8. First TestFlight build and dogfood
- **Approach:** Internal group with Luke. Dogfood a week on real boards. Triage crashes with kept dSYMs. **Stop:** TestFlight upload per the Stop conditions.
- **Verification:** build installed from TestFlight, live acceptance run.

---

### Stage S6 — iOS full quality

**Stage goal:** R12 to R17 delivered.
**Stage verification:** AE3 and AE4 pass on a device; Accessibility Inspector pass; launch time, scroll and memory budgets recorded in `docs/perf-budgets.md`.

#### S6-U1. Offline cache and outbox
- One-day store spike (SwiftData default, GRDB fallback). Repository reads local first and revalidates by delta. Outbox with idempotency keys, ordered per issue, retry with backoff, visible Outbox screen with Retry and Discard. Conflict rule: server state machine decides; failed writes explain why.
- **Tests:** airplane-mode matrix, duplicate-send safety via idempotency, cancelled-issue conflict (AE3), sign-out wipes store.

#### S6-U2. Push notifications
- APNs registration, notification service extension fetching content from the user's server, categories with actions (open, approve is not offered from a notification), quiet hours, per-kind toggles synced to the server, badge count. Uses S4-U3.
- **Tests:** AE4; relay-down behaviour; revoked device stops receiving.

#### S6-U3. Widgets
- My issues, Needs your review, Cycle progress (small, medium, lock-screen). Timeline provider reads the local store, never the network on the widget path.

#### S6-U4. Share extension
- Accepts URL, text, image; picks workspace and team (remembers last); writes to triage through the outbox so it works offline.

#### S6-U5. App Intents and Shortcuts
- Create issue, open my issues, open an issue by key. No Siri voice work beyond what intents give for free.

#### S6-U6. Accessibility, performance, polish
- Dynamic Type through the largest sizes, VoiceOver labels and rotor, reduced motion, contrast against DESIGN.md floors, haptics sparingly, empty and error states per the UX rules, localization-ready strings (English only shipped).

---

### Stage S7 — App Store

**Stage goal:** Public listing, if Luke chooses it (open question 2).

#### S7-U1. External TestFlight
- Public link, beta review notes, feedback loop on the board (TestFlight feedback creates triage issues through intake).

#### S7-U2. Listing and compliance
- Name, subtitle, keywords, screenshots (captured from the real app on a demo server), privacy nutrition answers, `PrivacyInfo.xcprivacy` review, support and privacy URLs, export compliance answers, review notes that explain "bring your own server" and supply a demo server and account so App Review can sign in. A hosted demo server at a stable address is part of this unit (needs Luke).

#### S7-U3. Submission
- Submit, handle review feedback, release. **Stop:** submission is Luke's go.

## Mapping from the 2026-10-12 iOS plan

| Old unit | New home | Change |
|---|---|---|
| U1 redirect schemes | S4-U1 | none |
| U2 scaffold | S5-U2 | build on the mini, xcodegen, not xtool-only |
| U3 auth | S5-U3 | adds QR pairing |
| U4 client | S5-U4 | adds delta and idempotency |
| U5 issue loop | S5-U5 | outbox arrives in S6 |
| U6 board parity | S5-U6 | adds search, inbox, review queue |
| U7 theme and keyboard | S5-U7 | none |
| U8 distribution | S5-U1, S5-U8, S7 | TestFlight is now the goal, not a stretch |
| Deferred: APNs, widgets, share, offline writes | S6 | reversed |

After this plan merges, the old plan gets a one-line "superseded in part" banner.

## Verification contract

- CLI: `pnpm --filter @tallyline/cli test`, `lint`, `typecheck`; golden outputs for every existing command pinned before restyle; manual terminal pass; demo GIF.
- API: `pnpm --filter @tallyline/api test`; `pnpm check` per PR; migrations applied to a copy of prod data first.
- Web: component tests, a screenshot per screen in the PR (DESIGN.md contract), keyboard tab-through.
- iOS: `swift test` on the mini; `xcodebuild` archive per unit; device smoke per unit; live acceptance script.
- Install: clean-machine install timing for AE1; one usability session with a non-technical person.
- Security review per stage: secrets, token storage, pairing abuse, SSRF on provider URLs, relay payload content.

## Risks

| Risk | Mitigation |
|---|---|
| ChatGPT-plan sharing is preview and partner-gated | Spike first, option hidden unless accepted; OpenRouter and compatible endpoint stand alone |
| App Review rejects a "bring your own server" app | Demo server and clear review notes (S7-U2); TestFlight remains the fallback distribution |
| Self-hosted push needs the publisher's APNs key | Content-free relay (D12); if Luke declines, push is Cloud-only and documented |
| Docker is a heavy ask for non-technical users | Three doors (D9); Cloud stays; evaluate OrbStack in S2-U1 |
| Scope is large and risks diluting the "serious Linear replacement" position | Ease-of-use treatment limited to CLI, install, first-run; board UI follows DESIGN.md unchanged |
| Mini keychain locked on build day | `release` already reports it; doctor-style preflight in the iOS script |
| CLI restyle regresses scripts or agents | KTD2 golden-file tests land first |

## Definition of done (per stage)

- All units merged with CI green and review clean; stage verification run and recorded as a comment on the stage ticket.
- Docs updated (`docs/`, README, ROADMAP.md).
- No secrets in the repo, logs or screenshots.
- Anything needing Luke is listed on the stage ticket, not buried in a PR.

## Open questions only Luke can answer

Same list as the origin document (push relay, App Store vs TestFlight, bundle ID and name, OpenAI participation, which Hermes, deploy host, Docker policy, spend cap, backup operator steps, signing identity use). Defaults are stated there and apply until he answers.
