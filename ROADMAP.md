# Roadmap

Goal: Tallyline is the tracker Luke runs his projects on (Kate first, then Cairn and the rest), and a serious self-hosted Linear replacement with a non-technical setup path, bring-your-own AI, and an iPhone app.

Status is read from `main` and merged PRs as of 2026-10-30. Unit specs live in two plans:

- PM-ready program (U1 to U25): [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md)
- Self-hosted program (S1 to S7): [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md), from the [requirements](./docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md)

Every open item sits in exactly one of three lists: buildable by an agent, needs Luke, or deferred.

## Open: buildable by an agent

| Unit | What ships | Notes |
|---|---|---|
| S3-U1 | Provider spike doc: OpenRouter PKCE, Hermes interface, ChatGPT-plan eligibility | Read-only. Decides S3-U5 |
| S3-U3 | Connect OpenRouter (PKCE) and any OpenAI-compatible endpoint, from web and CLI | Live check needs a capped test key from Luke |
| S3-U4 | Agent actions v1 on the provider seam: summarize, triage, dup-check, break-down, update and PR-brief drafts | Suggestions mechanism from #155 exists (`routes/issues/suggestions.ts`) |
| S3-U6 | Connect a coding agent in one flow (Claude Code, Codex, Cursor, opencode) | Merges only the `tallyline` entry; backup and undo |
| S3-U7 | Settings → AI page and a first-run checklist step | Depends on S3-U3 |
| S4-U3 | Push relay and device tokens, content-free payloads | Off unless configured. Enabling in prod needs Luke |
| S5-U7 | Silver Lining theme and iPad layout for the iOS app | Needs the Mac toolchain to build and test |
| S6-U1 to U6 | iOS offline outbox, push, widgets, share sheet, App Intents, accessibility | Needs the Mac toolchain; push needs S4-U3 |
| Re-verify | U19 relations, U22 sessions and delegate, U23 elicitation and PR links, U25 suggestions | Landed in #155; not yet checked unit by unit |

## Open: needs Luke

| Item | Action |
|---|---|
| U2 backups | Age key custody, bucket object lock, enable the timer, run the restore drill (#165, #172, #178) |
| U3 deploys | Restricted deploy user, first `ops/deploy.sh --assume-running` run (#188) |
| U6 production host housekeeping | Confirm deletions: orphan redis volume, dangling swarm records, `.env.bak-*` files |
| U11 Kate import | Provide the import credential (OQ5); approve each write |
| U21 mobile web | Check the installed web app on a phone |
| S1 CLI | Live check of `connect` and `doctor` against the hosted server |
| S2 install | Publish images and make them public, host and pin the installer, Homebrew tap, Railway template, clean-machine run, S2-U6 reachability spike |
| S3 providers | Answer open questions 4 and 5 (OpenAI participation, which Hermes); spend cap |
| S5 iOS | S5-U1 Apple setup (App ID, signing), S5-U8 first TestFlight build (pipeline in `apps/ios`, 897088d) |
| S7 App Store | External TestFlight, listing, submission |

The full open-question list is at the end of the requirements document.

## Done

| Area | Units | Evidence |
|---|---|---|
| Safety | U1 middleware fix, U4 webhook retention, U5 key revoke/rotate/expiry, U7 PR queue, U8 docs reconciliation; U2 and U3 repo side | #113, #142, #141, #154, #165, #188 |
| PM-ready | U9 plan import, U10 import CLI/MCP, U12 repo-to-project binding, U13 project pages and portfolio overview, U15 weekly cycles, U16 milestone links and labels | #140, #143, #145, #147, #146, #150, #158, #197 |
| Daily use | U14 status updates (API, MCP, web feed), U17 PR-to-issue mapping, U18 search, U20 agent inbox with mentions and answers, U21 installable web app | #170, #171, #166, #169, #167, #197 |
| Agent protocol | U22, U23, U25 (see re-verify above), U24 automated intake | #155, #149 |
| S1 CLI | Home screen, grouped help, keychain config, `connect`, `doctor`, browser sign-in | #179, #180, #181, #183, #189 |
| S2 install | `setup`, `stop`/`resume`/`backup`/`update`, installer script, Railway config, status endpoint and `/welcome` checklist | #190, #194 |
| S3 providers | S3-U2 bring-your-own provider, sealed keys, monthly spend limit | #187 |
| S4 mobile server | S4-U1 redirect schemes, S4-U2 QR pairing and devices, S4-U4 delta reads and idempotent writes | #182, #186, #184 |
| S5 iOS | S5-U2/U3 scaffold and pairing, S5-U4 typed client, S5-U5/U6 issue loop, review queue, board tabs; TestFlight build path | #191, #192, #193, 897088d |
| Release | v2.0.0 | #159 |

## Deferred

Revisit when a trigger in the PM-ready plan's Deferred ledger fires: loops, skills registry, WordInk intake, entitlements, account lifecycle, multi-workspace, integration trimming, templates, virtualization. S3-U5 (ChatGPT-plan provider) waits on the S3-U1 decision.

## History

[CHANGELOG.md](./CHANGELOG.md). Original product requirements R1 to R25: [plans/2026-10-08-1647-feat-docketry-plan.md](./plans/2026-10-08-1647-feat-docketry-plan.md). Research: [docs/research/2026-10-10-landscape.md](./docs/research/2026-10-10-landscape.md).
