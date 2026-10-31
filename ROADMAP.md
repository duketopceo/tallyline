# Roadmap

Goal: Tallyline is the tracker Luke runs his projects on (Kate first, then Cairn and the rest), and a serious self-hosted Linear replacement with a non-technical setup path, bring-your-own AI, and an iPhone app.

Status is read from `main` and merged PRs as of 2026-10-30. Unit specs live in two plans:

- PM-ready program (U1 to U25): [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md)
- Self-hosted program (S1 to S7): [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md), from the [requirements](./docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md)

Every open item sits in exactly one of three lists: buildable by an agent, needs Luke, or deferred.

## Open: buildable by an agent

| Unit | What ships | Notes |
|---|---|---|
| S6-U4, S6-U6 | iOS share sheet, accessibility | Needs the Mac toolchain; push uses the S4-U3 endpoints ([docs/push.md](./docs/push.md)) |

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
| S5 iOS | S5-U1 Apple setup (App ID with Push Notifications and the `group.app.tallyline.ios` App Group, plus a widgets App ID), S5-U8 first TestFlight build (pipeline in `apps/ios`, 897088d) |
| S4 push | Run the production push relay with the Apple push key; send one sandbox push to a test build ([docs/push.md](./docs/push.md)) |
| S7 App Store | External TestFlight, listing, submission |

The full open-question list is at the end of the requirements document.

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
| S6 iOS | S6-U1 issue cache and offline outbox; S6-U2 push settings, registration and tap routing; S6-U3 widgets; S6-U5 App Shortcuts | #211, #214, #215, #216 |
| Release | v2.0.0 | #159 |

## Deferred

Revisit when a trigger in the PM-ready plan's Deferred ledger fires: loops, skills registry, WordInk intake, entitlements, account lifecycle, multi-workspace, integration trimming, templates, virtualization. S3-U5 (ChatGPT-plan provider) is deferred by the S3-U1 spike: a shared server does not fit the plan-usage rules, and joining needs an interest form. Revisit if Luke submits it and OpenAI allows shared self-hosted servers.

## History

[CHANGELOG.md](./CHANGELOG.md). Original product requirements R1 to R25: [plans/2026-10-08-1647-feat-docketry-plan.md](./plans/2026-10-08-1647-feat-docketry-plan.md). Research: [docs/research/2026-10-10-landscape.md](./docs/research/2026-10-10-landscape.md).
