# Roadmap

Goal: Tallyline is the tracker Luke runs his projects on (Kate first, then Cairn and the rest), and a serious self-hosted Linear replacement with a non-technical setup path, bring-your-own AI, and an iPhone app.

**Living cloud Linear-parity ledger (API · web · iOS + pricing/COGS):** [docs/plans/CE-PLAN.md](./docs/plans/CE-PLAN.md) (updated 2026-11-05). Use that for SIWA identity, undercut-Linear pricing, and next execution slices. This file keeps the shipped U/S status and Luke-gated ops list.

Status is read from `main` (`56235dd`) and PR state as of 2026-11-05. The cloud beta roadmap is [docs/plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md](./docs/plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md); the cloud beta runs without Stripe. Unit specs live in two plans:

- PM-ready program (U1 to U25): [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md)
- Self-hosted program (S1 to S7): [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md), from the [requirements](./docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md)

Every open item sits in exactly one of three lists: buildable by an agent, needs Luke, or deferred.

## Open: buildable by an agent

Portfolio overview (`/overview`, `GET /v1/workspaces/:ws/portfolio`) is built on top of the GlitchTip error feed PR; see [docs/portfolio.md](./docs/portfolio.md).

Nothing new beyond the cloud beta units listed under "In review" below, which are built and waiting on review and merge. Unit specs: the cloud beta roadmap plan above. Skipped by owner decision for now: U2 (needs a device), U6 (web Apple sign-in, not built), U10 (owner-only), U11 (environment gate), U12 (board sync). The cloud beta has no Stripe.

## In review (cloud beta, 2026-11-05)

All open PRs are based on `main`; none are merged.

| PR | Unit | What |
|---|---|---|
| #256 | U3 | Write contract C6: issue version column and trigger, `STALE_WRITE` (409) |
| #255 | U4 | Issue team change, key aliases, issue URL API |
| #253 | U5 | iOS closers: team pill, Copy link, Blocked rotor, roadmap snap |
| Web Settings redesign PR (pending) | n/a | Not open yet as of this date; independent of the others |

Recommended merge order: #256 (U3), then #255 (U4: rebase, renumber its migration, wire `If-Match`), then #253 (U5: rebase `TrackerClient` and the outbox on U3), then the web Settings redesign (independent).

Merge-order hazard: #256 and #255 both add a migration numbered 0045 (U3: issue version column and trigger; U4: `issue_key_aliases`). Whichever merges second must renumber its migration file and its drizzle journal entry. #255 also notes that `0043_apple_provider.sql` is missing from the drizzle journal. Confirm the `If-Match` header name and the 409 `current` field in the CLI (#252, already merged) match what #256 ships.


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
| S3 providers | Answer open questions 4 and 5 (OpenAI interest form, which Hermes); spend cap; one live Connect OpenRouter run on a capped account. See the [provider spike](./docs/research/2026-10-ai-providers-spike.md) |
| S5 iOS | Done 2026-11-03: S5-U1 (App IDs and App Group) and S5-U8 (the app is on TestFlight; `ios-v1.0.3` was uploaded by `ios-release.yml`, which builds the widgets and share extension). Left: confirm pairing and sync on a device with each new build |
| S4 push | Run the production push relay with the Apple push key; send one sandbox push to a test build ([docs/push.md](./docs/push.md)) |
| S7 App Store | External TestFlight, listing, submission |

The full open-question list is at the end of the requirements document.

Ordered handoff with files and checks: [docs/next-tasks.md](./docs/next-tasks.md).

## Done

| Area | Units | Evidence |
|---|---|---|
| Safety | U1 middleware fix, U4 webhook retention, U5 key revoke/rotate/expiry, U7 PR queue, U8 docs reconciliation; U2 and U3 repo side | #113, #142, #141, #154, #165, #188 |
| PM-ready | U9 plan import, U10 import CLI/MCP, U12 repo-to-project binding, U13 project pages and portfolio overview, U15 weekly cycles, U16 milestone links and labels | #140, #143, #145, #147, #146, #150, #158, #197 |
| Daily use | U14 status updates (API, MCP, web feed), U17 PR-to-issue mapping, U18 search, U20 agent inbox with mentions and answers, U21 installable web app | #170, #171, #166, #169, #167, #197 |
| Agent protocol | U19, U22, U23, U25 (re-verified, gaps fixed; web relations, blocked badge, session PR links, suggestion chips; plan import writes blocks edges), U24 automated intake | #155, #149, #207, #212 |
| S1 CLI | Home screen, grouped help, keychain config, `connect`, `doctor`, browser sign-in | #179, #180, #181, #183, #189 |
| S2 install | `setup`, `stop`/`resume`/`backup`/`update`, installer script, Railway config, status endpoint and `/welcome` checklist | #190, #194 |
| S3 providers | S3-U1 provider spike; S3-U2 bring-your-own provider, sealed keys, monthly spend limit; S3-U3 Connect OpenRouter (PKCE) and compatible endpoints from web and CLI; S3-U7 Settings → AI and the checklist step; S3-U6 connect a coding agent in one step; S3-U4 agent actions on the provider seam and break-down suggestions; S3-U4b status-update polish, PR-brief draft, drafted answers to agent questions | #187, #203, #200, #205, #202, #213 |
| S4 mobile server | S4-U1 redirect schemes, S4-U2 QR pairing and devices, S4-U3 content-free push relay, S4-U4 delta reads and idempotent writes | #182, #186, #184, #206 |
| S5 iOS | S5-U2/U3 scaffold and pairing, S5-U4 typed client, S5-U5/U6 issue loop, review queue, board tabs; S5-U7 generated theme and iPad split view; TestFlight build path | #191, #192, #193, 897088d, #208 |
| S6 iOS | S6-U1 issue cache and offline outbox; S6-U2 push settings, registration and tap routing; S6-U3 widgets; S6-U4 share sheet (links and text; no images until attachments exist); S6-U5 App Shortcuts; S6-U6 accessibility pass | #211, #214, #215, #216, #217, #218 |
| Cloud beta | U1 iOS reconciliation: the `ios-v1.1.0` tag's `apps/ios` content equals `main` at `3291445` (#250; `git diff ios-v1.1.0 3291445 -- apps/ios` is empty; `main` has since moved on only by #254); U8 CLI `move-team`, `link`, `STALE_WRITE` exit code and doctor checks; U7 iOS workspace switching, test notification, feedback row and alternate icons; the plan itself. iOS UI stack: #244, #245, #246 and #250 merged; #247 to #249 were closed unmerged and their work (Now feed, agent pulse, projects, issue detail, grouped Settings) is on `main` | #244, #245, #246, #250, #251, #252, #254 |
| Release | v2.0.0 | #159 |

## Deferred

Revisit when a trigger in the PM-ready plan's Deferred ledger fires: loops, skills registry, WordInk intake, entitlements, account lifecycle, multi-workspace, integration trimming, templates, virtualization. S3-U5 (ChatGPT-plan provider) is deferred by the S3-U1 spike: a shared server does not fit the plan-usage rules, and joining needs an interest form. Revisit if Luke submits it and OpenAI allows shared self-hosted servers.

## History

[CHANGELOG.md](./CHANGELOG.md). Original product requirements R1 to R25: [plans/2026-10-08-1647-feat-docketry-plan.md](./plans/2026-10-08-1647-feat-docketry-plan.md). Research: [docs/research/2026-10-10-landscape.md](./docs/research/2026-10-10-landscape.md).
