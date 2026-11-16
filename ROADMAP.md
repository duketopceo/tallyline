# Roadmap

Goal: Tallyline is the tracker Luke runs his projects on (Kate first, then Cairn and the rest), and a serious self-hosted Linear replacement with a non-technical setup path, bring-your-own AI, and an iPhone app.

**Living cloud Linear-parity ledger (API · web · iOS + pricing/COGS):** [docs/plans/CE-PLAN.md](./docs/plans/CE-PLAN.md) (updated 2026-11-16). Use that for SIWA identity, undercut-Linear pricing, and next execution slices. This file keeps the shipped U/S status and Luke-gated ops list.

Status is read from `main` (`52cda96`) and PR state as of 2026-11-16. The cloud beta roadmap is [docs/plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md](./docs/plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md); the cloud beta runs without Stripe. Unit specs live in two plans:

- PM-ready program (U1 to U25): [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md)
- Self-hosted program (S1 to S7): [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md), from the [requirements](./docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md)

Every open item sits in exactly one of three lists: buildable by an agent, needs Luke, or deferred.

## Open: buildable by an agent

No pull requests are open. The November cloud-beta units that were in review (#256 U3, #255 U4, #253 U5) and the Settings redesign (#258) are merged. Portfolio overview (`/overview`, `GET /v1/workspaces/:ws/portfolio`) and the GlitchTip error feed are on `main`; see [docs/portfolio.md](./docs/portfolio.md).

W3 (public pricing copy: Free, Pro $8 / Business $14 yearly, self-host free, no checkout) shipped in #283. Next slice (spec in the [intake / agent-first home plan](./docs/plans/2026-11-03-1600-feat-intake-helpdesk-agent-first-home-plan.md) U7):

| Slice | What | Notes |
|---|---|---|
| I5 / #238 | iOS home as an agent-first project overview (active project cards, agents-working strip, issues as a tab) | Code can land; a device check still needs Luke. |

Intake helpdesk, public reports, the embeddable client, and the `SECRETS_KEY_MISSING` Settings callout already shipped in #240. Issues #232–#237 and #239 are still open and look done; they need a close/keep pass, not another build.

Skipped by owner decision for now: cloud-beta U2 (needs a device), U11 (environment gate), U12 (board sync). The cloud beta has no Stripe. U6 (web Apple sign-in) is built (#266, tests in #278); the login button stays hidden until the Apple Services ID and host env are set.

## In review

None. As of 2026-11-16 there are no open pull requests on `duketopceo/tallyline`.

## Open: needs Luke

| Item | Action |
|---|---|
| Apple console (OQ4) | Enable Sign in with Apple on the iOS App ID, create the web Services ID and return URL, and set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and `APPLE_BUNDLE_IDS` (iOS bundle ID audience, usually `app.tallyline.ios`) on the host. Until then the web Apple button does not show, and live iOS Sign in with Apple against `api.tallyline.app` cannot be confirmed. See [docs/auth.md](./docs/auth.md). |
| TestFlight 1.2.1 | `ios-v1.2.1` is tagged on `#281` (`929142b`). The release workflow [succeeded](https://github.com/duketopceo/tallyline/actions/runs/43846459344) and [the GitHub release](https://github.com/duketopceo/tallyline/releases/tag/ios-v1.2.1) is published. Left: confirm the 1.2.1 build in TestFlight, then pairing and sync on a device. |
| U2 backups | Age key custody, bucket object lock, enable the timer, run the restore drill (#165, #172, #178) |
| U6 production host housekeeping | Confirm deletions: orphan redis volume, dangling swarm records, `.env.bak-*` files |
| U11 Kate import | Provide the import credential (OQ5); approve each write |
| U21 mobile web | Check the installed web app on a phone |
| S1 CLI | Live check of `connect` and `doctor` against the hosted server |
| S2 install | Publish images and make them public, host and pin the installer, Homebrew tap, Railway template, clean-machine run, S2-U6 reachability spike |
| S3 providers | Answer open questions 4 and 5 (OpenAI interest form, which Hermes); spend cap; one live Connect OpenRouter run on a capped account. See the [provider spike](./docs/research/2026-10-ai-providers-spike.md) |
| S5 iOS | Done 2026-11-03: S5-U1 (App IDs and App Group) and S5-U8 (the app is on TestFlight; `ios-release.yml` builds the widgets and share extension). Latest tag is `ios-v1.2.1` (2026-11-16, offline share fix #281, plus Apple sign-in fixture tests from #278). Left: confirm pairing and sync on a device with each new build |
| S4 push | Run the production push relay with the Apple push key; send one sandbox push to a test build ([docs/push.md](./docs/push.md)) |
| S7 App Store | External TestFlight, listing, submission |
| Deploy ownership table | Fill the empty table in [docs/deploy.md](./docs/deploy.md#deploy-ownership) |

U3 deploys is no longer a Luke gate. Merges to `main` auto-deploy tallyline.app through [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml) on the production host (self-hosted runner labels `self-hosted,tallyline-deploy`). Docs-only, markdown-only, and `apps/ios/` commits are skipped. The last server deploy that ran was #279 (2026-11-13, 1:46 AM MST) and it succeeded; #274 and #279 fixed the backup path and backup env that had been failing those runs. #277 and #281 did not deploy (docs/prototype and iOS only). A tighter sudoers-restricted deploy user on the host remains optional hardening, not a blocker. Manual first-run `--assume-running` is superseded.

The full open-question list is at the end of the requirements document.

Ordered handoff with files and checks: [docs/next-tasks.md](./docs/next-tasks.md).

## Done

| Area | Units | Evidence |
|---|---|---|
| Safety | U1 middleware fix, U4 webhook retention, U5 key revoke/rotate/expiry, U7 PR queue, U8 docs reconciliation; U2 and U3 repo side | #113, #142, #141, #154, #165, #188 |
| PM-ready | U9 plan import, U10 import CLI/MCP, U12 repo-to-project binding, U13 project pages and portfolio overview, U15 weekly cycles, U16 milestone links and labels | #140, #143, #145, #147, #146, #150, #158, #197, #270 |
| Daily use | U14 status updates (API, MCP, web feed), U17 PR-to-issue mapping, U18 search, U20 agent inbox with mentions and answers, U21 installable web app | #170, #171, #166, #169, #167, #197 |
| Agent protocol | U19, U22, U23, U25 (re-verified, gaps fixed; web relations, blocked badge, session PR links, suggestion chips; plan import writes blocks edges), U24 automated intake | #155, #149, #207, #212, #240 |
| S1 CLI | Home screen, grouped help, keychain config, `connect`, `doctor`, browser sign-in | #179, #180, #181, #183, #189 |
| S2 install | `setup`, `stop`/`resume`/`backup`/`update`, installer script, Railway config, status endpoint and `/welcome` checklist | #190, #194 |
| S3 providers | S3-U1 provider spike; S3-U2 bring-your-own provider, sealed keys, monthly spend limit; S3-U3 Connect OpenRouter (PKCE) and compatible endpoints from web and CLI; S3-U7 Settings → AI and the checklist step; S3-U6 connect a coding agent in one step; S3-U4 agent actions on the provider seam and break-down suggestions; S3-U4b status-update polish, PR-brief draft, drafted answers to agent questions | #187, #203, #200, #205, #202, #213 |
| S4 mobile server | S4-U1 redirect schemes, S4-U2 QR pairing and devices, S4-U3 content-free push relay, S4-U4 delta reads and idempotent writes | #182, #186, #184, #206 |
| S5 iOS | S5-U2/U3 scaffold and pairing, S5-U4 typed client, S5-U5/U6 issue loop, review queue, board tabs; S5-U7 generated theme and iPad split view; TestFlight build path | #191, #192, #193, 897088d, #208 |
| S6 iOS | S6-U1 issue cache and offline outbox; S6-U2 push settings, registration and tap routing; S6-U3 widgets; S6-U4 share sheet (links and text; no images until attachments exist; offline share files once under the same key); S6-U5 App Shortcuts; S6-U6 accessibility pass | #211, #214, #215, #216, #217, #218, #281 |
| Cloud beta | U1 iOS reconciliation; U3 write contract C6 (`If-Match`, `STALE_WRITE`); U4 issue team change, key aliases, issue URL; U5 iOS closers (team pill, Copy link, Blocked rotor, roadmap snap); U7 iOS extras; U8 CLI `move-team`, `link`, `STALE_WRITE` and doctor; U6 web Sign in with Apple and linked methods (code; live button waits on the Apple console); Settings redesign; the plan itself. iOS UI stack: #244, #245, #246 and #250 merged; #247 to #249 were closed unmerged and their work (Now feed, agent pulse, projects, issue detail, grouped Settings) is on `main` | #244, #245, #246, #250, #251, #252, #253, #254, #255, #256, #258, #266, #278 |
| Hosted site | Auto-deploy on merge to `main`; deploy workflow backup path and host backup env | #264, #274, #279 |
| Web chrome | Grouped sidebar, project switcher, public landing, project logos, landing hero rest, sidebar project order, hosted list prices on the landing page (W3; checkout still off) | #271, #280, #275, #276, #283 |
| Account and agents | Profile, password, workspace rename and leave, credential audit; agent plugins and ticket hooks; GlitchTip error feed | #272, #268, #269 |
| Release | v2.0.0 | #159 |

## Deferred

Revisit when a trigger in the PM-ready plan's Deferred ledger fires: loops, skills registry, WordInk intake, entitlements, account lifecycle, multi-workspace, integration trimming, templates, virtualization. S3-U5 (ChatGPT-plan provider) is deferred by the S3-U1 spike: a shared server does not fit the plan-usage rules, and joining needs an interest form. Revisit if Luke submits it and OpenAI allows shared self-hosted servers. C3 (Stripe + `BILLING=on`) stays deferred until Luke is ready to take money.

## History

[CHANGELOG.md](./CHANGELOG.md). Original product requirements R1 to R25: [plans/2026-10-08-1647-feat-docketry-plan.md](./plans/2026-10-08-1647-feat-docketry-plan.md). Research: [docs/research/2026-10-10-landscape.md](./docs/research/2026-10-10-landscape.md).
