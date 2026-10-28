---
title: Tallyline as self-hosted Linear — iOS client, agent providers, zero-skill setup, polished CLI
date: 2026-10-28
type: requirements
origin: owner request 2026-10-28 (Luke), CLI clarification same night
status: ready-for-planning
plan: docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md
---

# Tallyline as self-hosted Linear: iOS client, agent providers, zero-skill setup, polished CLI

Mode note: this brainstorm ran headless (no live dialogue). Every question that
would have been asked is resolved below with a stated default and a reason, or
listed in **Open questions for Luke** when only he can answer it. Claims about
the repo are marked **verified** (read from `main` at `acd20dd` on 2026-10-28)
or **assumed**.

## Problem frame

Tallyline already is a Linear-class tracker with agents as first-class actors
(verified: [README.md](../../README.md), [docs/agents.md](../agents.md),
[docs/mcp.md](../mcp.md)). Four gaps stand between it and "Linear, but you own
it, and a non-technical person can run it":

1. **No phone client.** A native iOS app was planned on 2026-10-12
   ([docs/plans/2026-10-12-2107-feat-ios-app-plan.md](../plans/2026-10-12-2107-feat-ios-app-plan.md))
   and parked in ROADMAP's Deferred list. `apps/ios` does not exist (verified).
   The plan also deferred push, widgets, share extension and the offline write
   queue. Luke now wants it at full quality.
2. **Agents are bring-your-own-everything.** Today a human mints a `tly_agt_*`
   key by hand (curl, or the Agents screen) and pastes it into a harness config
   (verified: [docs/agents.md](../agents.md) section 1). Server-side model help
   exists but needs one pasted `TALLYLINE_LLM_API_KEY` env var (verified:
   [docs/llm-assist.md](../llm-assist.md)). There is no "sign in with the AI
   account you already pay for".
3. **Setup assumes a developer.** Self-host is `git clone`, `openssl rand`,
   `docker compose` and editing `.env` (verified: README "Self-host",
   `docker-compose.selfhost.yml` takes ~40 env vars). A non-technical person
   cannot do this.
4. **The CLI is functional but plain.** `tallyline` has a small ANSI layer
   (`tools/cli/src/pretty.ts`) and a `--json` contract, but no wizard, no
   doctor, no spinners, no friendly errors, and needs three env vars
   (verified: `tools/cli/README.md`). OmaSeal's recent CLI revamp is the bar.

## Positioning (decision, constrains everything below)

**Tallyline is a serious Linear replacement that you host yourself.** Not a
hobby tool, not a vibe-coding toy. The ease-of-use treatment (guided setup,
friendly language, polish) applies to **install, setup, the CLI and the first-run
experience**. The core product keeps its dense, keyboard-first, calm design
contract ([DESIGN.md](../../DESIGN.md), luke-agents UX_FIRST rules): no cute mascots,
no emoji-as-UI, no marketing voice inside the board. Friendly in the doorway,
serious in the room.

## Actors

- **A1 Owner-operator** (Luke): technical, runs many projects, wants it solid.
- **A2 Non-technical owner**: a founder, ops lead or small-team manager who
  can use a browser and an iPhone, has never opened a terminal on purpose, and
  wants "Linear but ours" running today.
- **A3 Team member**: signs in with GitHub or email, uses web and iPhone.
- **A4 Agent**: a coding harness (Claude Code, Codex, Cursor, opencode) that
  connects to the board, or a Tallyline-run agent that acts using the owner's
  AI provider.
- **A5 Tallyline maintainer** (Luke): ships the iOS app and the push relay.

## Key decisions (resolved defaults)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | What does "self-hosted Linear" mean for scope? | Parity on the daily loop (triage, my issues, board, cycles, projects, roadmap, search, inbox, review queue) on web **and** iOS, on a server the owner controls. Not a Linear clone feature-for-feature. | The API already covers this surface; the gap is clients and setup, not features. |
| D2 | Two agent shapes or one? | **Both, kept separate.** Shape B: *connect a coding agent* (it connects to Tallyline as an MCP/REST client; Tallyline pays nothing). Shape A: *Tallyline-run agent actions* (Tallyline calls a model using the owner's AI provider). | They have different trust and cost models. B exists today; A is new. |
| D3 | Which AI providers, in what order? | 1) **OpenRouter** one-click OAuth. 2) **OpenAI-compatible endpoint** (covers Hermes, local llama.cpp, any gateway) with an API key. 3) **ChatGPT plan** via "Sign in with ChatGPT", gated on a spike. 4) Direct vendor API keys later if asked. | Luke named OpenRouter first. OpenRouter documents a PKCE flow that returns a user-controlled key and a no-redirect "paste the code" mode for headless installs (verified 2026-10-28, openrouter.ai/docs/guides/overview/auth/oauth). Existing LLM seam already speaks OpenAI-style (verified: `docs/llm-assist.md`). |
| D4 | What does "login with Codex" mean? | Sign in with ChatGPT so Tallyline-run agent actions count against the owner's ChatGPT plan instead of a metered API key. OpenAI documents this as a preview for participating apps, with a path for open-source tools (verified 2026-10-28, help.openai.com "Using your ChatGPT plan in other apps and sites"; developers.openai.com `siwc/token-sharing-open-source`). Preview limits exist (Responses API with `store:false`, `stream:true`). **Ship behind a spike**; do not promise it until the spike passes and OpenAI participation is confirmed. | Real, but preview and partner-gated. |
| D5 | "Harnesses only as MCP, login with GitHub"? | Shape B is the answer to that reading: Claude/Codex/Cursor connect through the OAuth-protected `/mcp` endpoint (already live), and humans sign in with GitHub (already live). New work is making it one click plus auto-config, not new protocol. | Verified: `/mcp` + OAuth 2.1 + DCR in [docs/mcp.md](../mcp.md); GitHub sign-in in [docs/auth.md](../auth.md). |
| D6 | Where do AI-provider credentials live? | Server side, per workspace, AES-256-GCM at rest with the existing `AUTH_SECRET_KEY` mechanism, admin-only, never returned by the API, never in logs or events. | Reuses the pattern for sign-in provider secrets (verified: [docs/auth.md](../auth.md) "Providers: env vs. DB"). |
| D7 | What may a Tallyline-run agent do? | Start read-and-suggest: summarize, triage-suggest, dup-check (exist), plus break-down, status-update draft, PR-brief draft, inbox answers. Output lands as a **suggestion a human accepts**, tagged with the agent glint. Writes beyond that need an explicit workspace setting, and review stays human-only. | Keeps the "review is a human decision" invariant (verified: [docs/agents.md](../agents.md) PLAN-056). |
| D8 | Spend control | Every AI provider has a monthly cap and a per-action ceiling set at connect time with a safe default; hitting it pauses agent actions and says so in plain language. | Non-technical owners must not get a surprise bill. |
| D9 | How does a non-technical person get a server? | Three doors, same result: **(a) one-click deploy button** (Railway template first), **(b) `tallyline setup`** on any Mac/Linux/Windows-WSL machine with a guided wizard that installs or checks Docker and starts the stack, **(c) Tallyline Cloud** stays the zero-ops option (exists: tallyline.app). iOS and web onboarding work against all three. | A website button is the lowest-skill door; the CLI wizard is the "my own machine" door. |
| D10 | CLI language | **Stay TypeScript.** Add one runtime-bundled prompt/spinner library and extend the existing ANSI layer. Do not rewrite in Go to copy OmaSeal's cobra/fang/lipgloss/huh stack. Copy OmaSeal's *behaviour* (grouped help, doctor, setup wizard, TTY-only decoration, byte-stable non-TTY output, aliases for one release, demo GIF). | The CLI shares types with the API and MCP server, ships via npm, and is MIT; a second toolchain buys looks we can get in TS. |
| D11 | iOS framework and floor | SwiftUI, iOS 17+, Swift 6, no UI dependencies, single App Store app that points at any server (instance URL) plus Tallyline Cloud as default. | Carries over the settled decisions from the 2026-10-12 plan. |
| D12 | Self-hosted push notifications | A small **Tallyline push relay** run by the maintainer (stateless, open source). Self-hosted servers send a minimal "something happened" ping to the relay; the relay forwards to APNs; the app fetches the real content from the owner's server. | An App Store app can only be pushed to with the publisher's Apple key, which cannot live on every self-hosted server. Same pattern other self-hosted apps use. **Assumed** acceptable to Luke; see open questions. |
| D13 | Pairing the phone | **QR pairing** from web Settings and from the terminal (`tallyline pair`): QR carries server address plus a single-use, 5-minute code; the app exchanges it for a revocable device session. Typing a server URL and signing in stays as the fallback. | Zero typing for non-technical users; no passwords on the phone. |
| D14 | Distribution | TestFlight internal first, then external TestFlight, then App Store. Builds run on the Mac mini over `ssh mini`. | Luke has the paid account and the pipeline exists (see plan, "Build and TestFlight pipeline"). |
| D15 | Where does the old iOS plan go? | It is **superseded in part**: its OAuth, API-client, screens and theme units carry forward into Stage 5; its xtool-on-Linux build path is replaced by the Mac mini path for anything that ships; its "defer push, widgets, share, offline" list is reversed. | Luke's ask changed the bar. |

## Requirements

### A. Positioning and onboarding

- **R1.** A non-technical owner can go from "nothing" to a running, reachable
  Tallyline with a first project and one invited teammate without opening a
  text editor, editing a config file, or reading the word "Postgres".
- **R2.** First run of the web app shows a short checklist ("Welcome to
  Tallyline"): name your workspace, invite someone, connect GitHub, connect an
  AI provider, connect a coding agent, install the iPhone app. Every step is
  skippable, resumable, and ends with a visible "done".
- **R3.** Every setup failure is shown in plain language with one recommended
  next action. No stack traces, no raw error codes as the only message.
- **R4.** The settings a self-hoster needs (domain, sign-in methods, AI
  providers, backups, email) are editable in the web UI; environment variables
  remain the override for experts, never the only path.

### B. Agent providers (Shape A) and connecting agents (Shape B)

- **R5.** An admin can connect an AI provider for the workspace from
  Settings. OpenRouter is one click (browser approval, no key pasting). An
  OpenAI-compatible endpoint (including Hermes) takes a base URL and optional key.
- **R6.** If the ChatGPT-plan option passes its spike (D4), the admin can sign
  in with ChatGPT and choose a weekly usage limit; the UI states the preview
  limits plainly. If the spike fails, the option does not appear.
- **R7.** Provider credentials are encrypted, admin-only, never shown after
  save, and every connect, change and disconnect writes an event. A "test
  connection" button reports success or a plain-language reason.
- **R8.** Tallyline-run agent actions use the connected provider, show which
  model ran and what it cost in the activity trail, obey the spend cap (D8), and
  produce suggestions a human accepts (D7).
- **R9.** "Connect a coding agent" is one flow in web and CLI: pick Claude Code,
  Codex, Cursor or opencode; Tallyline shows or applies the exact config and
  verifies the agent appears on the board. Sign-in uses the OAuth endpoint, with
  GitHub as the human sign-in.
- **R10.** An agent can never approve a review, mint keys, or exceed its scopes
  because of how it was connected (existing rules hold).

### C. iOS client

- **R11.** Native SwiftUI app: sign in by QR pairing or server URL; workspace
  switcher; triage, my issues, issue list with filters, issue detail with
  comments and activity, create and edit, board, projects, cycles, labels,
  roadmap, search, inbox, **review queue** (approve or send back as a human).
- **R12.** **Offline**: the last-seen board is readable with no connection;
  comments, state changes and new issues made offline go to a visible outbox,
  retry automatically, and show failures with a Retry or Discard choice. Server
  state-machine rules always win.
- **R13.** **Push**: notifications for assignment, mention, review requested,
  agent question answered, with quiet-hours and per-kind toggles. Payloads carry
  no issue text (D12).
- **R14.** **Widgets**: My issues, Needs your review, Cycle progress. Lock-screen
  and home-screen sizes.
- **R15.** **Share sheet**: share a URL, text or screenshot from any app to
  create a triage issue in a chosen workspace and team.
- **R16.** App Intents so Shortcuts can create an issue and open "my issues".
- **R17.** Design fidelity: Silver Lining tokens, dark and light, Dynamic Type,
  VoiceOver labels, reduced motion respected, iPad uses split view with keyboard
  shortcuts ([DESIGN.md](../../DESIGN.md), 2026-10-12 plan R7, R8).
- **R18.** Sessions are device-bound, revocable from web Settings, held in the
  Keychain, and fail closed (revoked means signed out, no stale data shown after
  sign-out).

### D. CLI

- **R19.** `tallyline` with no arguments on a terminal shows a branded home
  screen: connection status, what needs attention, and the three most useful
  next commands. Never a raw help dump.
- **R20.** Guided commands: `setup` (stand up a server), `connect` (log in to an
  existing one), `pair` (phone), `agent connect` (coding agents and AI
  providers), `doctor`, `config`, `update`, `backup`.
- **R21.** `doctor` checks everything a user could get wrong, groups results,
  explains each failure in plain language with a fix, and offers `--fix` for the
  safe ones.
- **R22.** Output contract (carried from OmaSeal and from the current CLI):
  decoration only on an interactive terminal; piped or `--json` output is plain
  and stable; `NO_COLOR` and `TERM=dumb` respected; exit codes unchanged (0 ok,
  1 error, 2 usage, 3 unauthorized, 4 not found, 5 conflict); confirmations
  default to No; secrets never printed or put in arguments; every existing
  command name and flag keeps working.
- **R23.** The CLI reads and writes a global profile (server, workspace, agent
  name) in a per-user config and keeps tokens in the OS keychain when one
  exists (file mode 0600 otherwise). Environment variables still override.
  Users never edit the file by hand; `tallyline config` is the editor.
- **R24.** Branded art (tally-strike banner, status glyphs), a recorded demo GIF
  in the CLI README, and a design doc for the CLI language (see CLI design
  below).

### E. Distribution and release

- **R25.** One install line per platform that verifies a pinned checksum
  (OmaSeal `install.sh` pattern): macOS and Linux first, Windows via WSL guidance
  then a native installer later. Homebrew tap and `npx @tallyline/cli` as
  alternates.
- **R26.** The iOS app ships to TestFlight from the Mac mini with a single
  command, with build numbers, symbol files kept, and no credentials in the repo.

## Acceptance examples

- **AE1 (R1, R3).** A non-technical owner on a Mac runs the one install line,
  answers three friendly questions, and ends on a screen that says their
  Tallyline is ready, with a link, a QR for their phone, and "next: invite a
  teammate". If Docker is missing, the wizard says "Tallyline needs a free app
  called Docker. Install it now? [Y/n]" and does it, not "docker: command not found".
- **AE2 (R5, R8).** Admin clicks Connect OpenRouter, approves in the browser,
  returns to a green "Connected: your OpenRouter account, cap $10 per month".
  Opening an issue and pressing Suggest breakdown produces suggested sub-issues
  tagged with the agent glint; nothing is created until a human accepts.
- **AE3 (R12).** On a plane, the user comments on two issues and moves one to
  done. The outbox shows 3 pending items. On landing, all three sync; one fails
  because the issue was cancelled meanwhile and says so with Retry or Discard.
- **AE4 (R13).** A teammate is mentioned. The lock screen shows "Tallyline: you
  were mentioned" with no issue text; opening the app fetches and shows the
  comment.
- **AE5 (R21).** `tallyline doctor` on a server whose database is not running
  prints "The database is not running. Your boards are safe. Fix: run
  `tallyline start`, or press Enter to do it now."

## CLI design (look, feel, language)

Intent from Luke: **polish, not typed words and variables.** Approachable for
less technical people, in the family of `gh`, `vercel` and charm/gum-style TUIs.
Only the CLI gets this ease-of-use treatment; the product stays serious.

### Principles

1. **Say what is happening, then what to do next.** Every screen ends with a
   "Next" line naming one to three commands.
2. **Plain words.** "database", "your server", "your phone", not Postgres,
   container, PAT, DCR. A glossary table in the CLI design doc maps jargon to
   words; the error catalog maps every error code to message plus fix.
3. **Colour is meaning.** One accent (signal azure, the Silver Lining accent
   `#3ea1f7` on dark and `#0b66cc` on light, verified in `DESIGN.md` and
   `assets/brand/README.md`) for brand and primary action; green, amber, red only
   for ok, attention and failure, each paired with a glyph so colour is never
   the only signal. Reuse the state glyphs already in `tools/cli/src/pretty.ts`.
4. **Show progress.** Spinner for anything over about 400 ms, a step list for
   multi-step jobs, a progress bar only when the total is known.
5. **Good defaults, few questions.** Every prompt shows a default in brackets
   and Enter accepts it. `--yes` accepts all defaults for scripts.
6. **Never trap the user.** Esc or Ctrl-C always exits cleanly with a note on
   how to resume. Confirmations default to No for destructive actions.
7. **Machine contract untouched.** Everything above is TTY-only (R22).

### Brand art

The mark is four upright strokes struck by one diagonal line (verified:
`assets/brand/mark.svg`). Terminal rendering, azure on the strike, ink on the
strokes, falling back to plain text when colour is off:

```text
   ┃ ┃ ┃ ┃ ╱
   ┃ ┃ ┃ ┃╱
   ┃ ┃ ┃╱┃
   ┃ ┃╱┃ ┃     tallyline
   ┃╱┃ ┃ ┃     your team's work, in one place
```

The exact glyph art is a proposal to be checked against the SVG at Stage 1 and
signed off by Luke, as OmaSeal did for its mark.

### Screen 1: home (`tallyline`, no arguments, connected)

```text
  tallyline  v2.1.0                         ● connected to acme.tallyline.app

  Good morning, Luke.

  Needs you
    ◕ 2 issues waiting for your review
    ◌ 5 new in triage

  Working now
    ◐ ENG-142  Fix token refresh race                    claude · 18 min
    ◐ ENG-150  Import plan from Kate                     codex  ·  3 min

  Next
    tallyline review        look at what's waiting
    tallyline ready         pick something to work on
    tallyline pair          put Tallyline on your phone
```

### Screen 2: setup wizard (`tallyline setup`)

```text
  ┃┃┃┃╱  Welcome to tallyline
         Let's get your own Tallyline running. It takes about 5 minutes.

  ◇ What should we call your workspace?
  │ Acme                                                   (Enter to accept)
  │
  ◇ Where should it run?
  │ ● On this computer      easiest, only reachable from here and your phone at home
  │ ○ On a server I own     we'll show you the one command to run there
  │ ○ Help me choose
  │
  ◇ Check this computer
  │ ✔ macOS 15, enough memory and disk
  │ ✖ Docker is not installed
  │   Tallyline uses a free app called Docker to run safely on its own.
  │   Install Docker Desktop now? [Y/n]
  │
  ◒ Starting your database…                                       12s
  ✔ Database ready
  ✔ Tallyline is running
  ✔ Backup schedule set: every night at 2:00 AM

  ┌───────────────────────────────────────────────────────────┐
  │  Your Tallyline is ready:   http://localhost:3100         │
  │  We opened it for you. Create your account to finish.     │
  └───────────────────────────────────────────────────────────┘

  Next
    Scan to put it on your phone       ▄▄▄▄▄ ▄ ▄▄▄▄▄   (tallyline pair)
    Invite a teammate                  Settings → Invites
    Connect an AI provider             tallyline agent connect
```

### Screen 3: doctor

```text
  tallyline doctor

  Your server
    ✔ Tallyline is running                       v2.1.0, up 3 days
    ✔ Database                                   healthy, 214 MB
    ✖ Backups                                    last good backup was 9 days ago
        Your backups stopped. Your data is safe today, but you could lose
        recent work if something breaks.
        Fix: tallyline backup now      (or press Enter to do it now)

  Your connections
    ✔ GitHub                                     2 repositories linked
    ▲ AI provider                                none connected yet (optional)
        Connect one to get summaries and suggested breakdowns.
        Fix: tallyline agent connect

  This computer
    ✔ Signed in as luke on acme.tallyline.app
    ✔ tallyline is up to date

  1 problem, 1 suggestion.   Fix the problem now? [Y/n]
```

### Screen 4: connecting an AI provider (`tallyline agent connect`)

```text
  ◇ Which AI should power Tallyline's agent actions?
  │ ● OpenRouter           one click, many models, you pay OpenRouter directly
  │ ○ ChatGPT plan         use the plan you already have (preview)
  │ ○ Another service      Hermes, a local model, or any OpenAI-compatible URL
  │ ○ I just want to connect my coding agent (Claude, Codex, Cursor)

  ◒ Opening your browser to approve OpenRouter…
    Not on this computer? Open  https://openrouter.ai/auth?…  and paste the code here.
  ✔ Connected: your OpenRouter account

  ◇ Monthly spending limit
  │ $10    (Enter to accept, you can change it in Settings → AI)
  ✔ Limit set. Tallyline pauses agent actions at $10 and tells you.

  Next
    tallyline agent test        ask it to summarize an issue
```

### Screen 5: a plain-language error

```text
  ✖ Couldn't reach acme.tallyline.app

    Your computer is online, but the server isn't answering.
    It may be restarting, or the address may have changed.

    Try        tallyline doctor
    Details    TLY-NET-ECONNREFUSED  (share this if you ask for help)
```

### Screen 6: help (`tallyline --help`), grouped like OmaSeal

```text
  Work                  ready · claim · start · comment · done · review
  Set up                setup · connect · pair · config · update
  Agents                agent connect · agent list · agent test
  Health                doctor · status · backup
  Everything else       tallyline help all
```

### What stays as it is

`--json`, stable exit codes, `dok` alias, `tly` alias, all existing flags and
env vars, and `tallyline work`. Renames use hidden aliases for one release
(OmaSeal's rule).

## Scope boundaries

### Deferred for later
- Android client. Mac/Windows native apps. Apple Watch. Live Activities. Siri
  voice intents beyond App Intents for Shortcuts. iPad multi-window.
- Direct vendor API-key providers (Anthropic, Google) as first-class options
  (the OpenAI-compatible option covers gateways in the meantime).
- A hosted "Tallyline Cloud for teams who self-serve" billing rework.
- Windows-native installer (WSL guidance first).

### Outside this product's identity
- A consumer-style cutesy UI inside the board.
- Tallyline holding users' ChatGPT or OpenRouter credentials on infrastructure
  we run (providers connect to the owner's own server, not ours; the push relay
  sees no content).
- Rewriting the CLI in another language for looks.
- Auto-merging or auto-approving agent work.

## Dependencies and assumptions

- **Verified:** OAuth 2.1 server with DCR, `/mcp` over Streamable HTTP, GitHub /
  Google / OIDC sign-in, encrypted DB-stored provider secrets (`AUTH_SECRET_KEY`),
  an LLM seam with OpenRouter default, `notifications` inbox rows, `/events/stream`
  SSE, selfhost compose, ASCII-safe CLI colour layer, brand SVGs.
- **Verified:** private-use redirect schemes are still rejected by
  `validRedirectUri` (`apps/api/src/services/mcp-oauth.ts:155`), so the old iOS
  unit U1 is still open.
- **Verified 2026-10-28 (read-only):** from omarchy-max, `ssh mini` reaches an
  M1 Mac mini, macOS 27.2, Xcode 27.1, `xcodegen` installed, no fastlane. A
  `release` script exists there for Kate and Cairn, with an App Store Connect key
  file path read from a local env file and a distribution signing identity in the
  login keychain. Not yet verified: Tallyline's App ID, App Store Connect app
  record, or a successful build.
- **Assumed:** Hermes exposes an OpenAI-compatible endpoint or can be fronted by
  one. Confirm in the Stage 3 spike before the option ships.
- **Assumed:** OpenAI will accept Tallyline as a participating open-source tool
  for ChatGPT-plan token sharing (preview). Gated on Stage 3 spike.
- **Assumed:** Docker Desktop's license is acceptable to recommend to
  non-technical users; alternatives (OrbStack, Podman) are a Stage 2 question.
- **Assumed:** Luke runs the push relay (D12).

## Open questions

### Resolve before planning
None. All product-shaping questions have defaults above.

### Only Luke can answer (also listed in the plan)
1. **Push relay.** OK to run a small public relay at a Tallyline-owned
   hostname (it needs the App's APNs key)? Without it, self-hosted installs get
   no push. Default if unanswered: yes, open source, content-free.
2. **App Store.** Go for a public App Store listing (needs a reviewable demo
   server, privacy answers, support URL), or stay on TestFlight (up to 10,000
   external testers) for now? Default: TestFlight through Stage 6, App Store in
   Stage 7.
3. **Bundle ID and app name.** `app.tallyline.ios` (per the 2026-10-12 plan) vs
   the `com.duketopceo.*` prefix used by Kate and Cairn, and whether "Tallyline"
   is free as an App Store name. Default: `app.tallyline.ios`, confirm availability.
4. **OpenAI participation.** Will Luke apply Tallyline as a "Sign in with ChatGPT"
   partner or open-source tool (a form only he can submit)? Default: spike first;
   if no, ChatGPT-plan option is dropped.
5. **Hermes.** Which Hermes do you mean (Nous Research's agent, or the Hermes
   box on your network), and where does it listen? Default: any OpenAI-compatible
   URL.
6. **One-click deploy host.** Railway first (you use it), or another? Default:
   Railway template, Docker local wizard second.
7. **Docker for non-technical users.** Fine to require Docker Desktop (free
   for small teams, paid for large companies) or prefer OrbStack on Mac?
   Default: Docker Desktop with OrbStack mentioned.
8. **Spend cap default.** $10 per month per workspace for AI providers. OK?
9. **Backups (carried).** The U2 operator steps still wait on the key being
   saved and the Cloudflare account and token. Stage 2's `tallyline backup` and
   doctor depend on them being done.
10. **Signing identity.** Confirm the mini's Apple Distribution identity and the
    ASC API key may be used for a third app (Tallyline) alongside Kate and Cairn.
