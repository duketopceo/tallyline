# Roadmap

The single roadmap and status ledger is [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md). It supersedes the old "Now / Next / Later" table that lived here.

## Status (2026-10-27)

Goal: Tallyline is the tool Luke runs his projects on, Kate first, then Cairn and the rest. Status below is read from `main` and the open PRs; the unit specs and requirements live in the plan linked above.

| Phase | Unit | Status | Evidence |
|---|---|---|---|
| 0 Safe | U1 middleware fix | done | #113 |
| 0 Safe | U2 scheduled backups, restore drill | repo side done; operator steps open (age key, bucket lock, enable timer, restore drill) | #165 |
| 0 Safe | U3 deploy lock and provenance | repo side done (script, labels, docs, tests); operator steps open (restricted deploy user, first `--assume-running` run) | this PR |
| 0 Safe | U4 webhook-event retention | done | #142 |
| 0 Safe | U5 key revoke, rotate, expiry | done | #141 |
| 0 Safe | U6 cluster2 housekeeping | open, operator (needs Luke to confirm deletions) | n/a |
| 0 Safe | U7 clear the PR queue | partial: #133, #137, #138 landed; #158, #159, #161-#163 open | PR list |
| 0 Safe | U8 docs and stub reconciliation | done | #154 |
| 1 PM-ready | U9 plan import core | done | #140, #150 |
| 1 PM-ready | U10 import CLI, MCP tools, skill step | done | #143 |
| 1 PM-ready | U11 Kate import run | open, operator (OQ5 credential, Luke approves each write) | n/a |
| 1 PM-ready | U12 repo-to-project binding | done | #145 |
| 1 PM-ready | U13 project pages, portfolio overview | partial: project health page in PR | #158 |
| 1 PM-ready | U15 weekly cycle auto-schedule | done | #147 |
| 1 PM-ready | U16 milestone-issue link, labels | done | #146 |
| 1b Daily use | U14 project status updates | PR (API and MCP; web feed to follow) | #170 |
| 1b Daily use | U17 PR-to-issue mapping v2 | todo (branch-name push mapping exists) | none |
| 1b Daily use | U18 workspace search | done | #166 |
| 1b Daily use | U19 issue relations | landed in #155, not re-verified per unit | #155 |
| 1b Daily use | U20 agent inbox, ready excludes blocked | PR (mentions and answered questions not yet in inbox) | #169 |
| 1b Daily use | U21 mobile web and installable PWA | done (device check by Luke pending) | #167 |
| 2 Agent protocol | U22 sessions and delegate, U23 elicitation and PR links, U25 suggestions | landed in #155, not re-verified per unit | #133, #155 |
| 2 Agent protocol | U24 automated intake | done | #149 |

Also open: release PR #159 (v2.0.0).

Deferred with revisit triggers: loops, skills registry, WordInk intake, entitlements, account lifecycle, multi-workspace, integration trimming, templates, virtualization.

## Next: self-hosted Linear program (planned 2026-10-28)

Tallyline as a serious Linear replacement you host yourself, with a non-technical setup path, AI providers you bring, and a full-quality iPhone app. Requirements: [docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md](./docs/brainstorms/2026-10-28-self-hosted-linear-ios-agent-providers-cli-requirements.md). Staged plan: [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md). It supersedes the iOS plan of 2026-10-12 in part; the native iOS app and delta sync leave the Deferred list and live in S4 to S7.

| Stage | Ships | Status | Depends on |
|---|---|---|---|
| S1 Polished CLI | Branded home screen, `doctor`, `config`, `connect` (browser sign-in via device authorization, or a pasted token), plain-language errors | built; live check against the hosted server pending | none |
| S2 Zero-skill install and onboarding | `tallyline setup`, one-line installer, first-run checklist, one-click deploy | planned | S1 |
| S3 AI providers and agent connection | OpenRouter and OpenAI-compatible providers, suggestions, one-flow coding-agent connect, ChatGPT plan if the spike passes | planned | S1, S2 |
| S4 Mobile server groundwork | QR pairing, devices, push relay, delta sync, idempotent writes, native redirect schemes | planned | none |
| S5 iOS v1 | TestFlight build with the core loop and review queue | planned; needs Luke for Apple setup | S4 |
| S6 iOS full quality | Offline and outbox, push, widgets, share sheet, App Intents, accessibility | planned | S5 |
| S7 App Store | External TestFlight and public listing | planned; Luke decides | S6 |

Open questions that only Luke can answer are listed at the end of the requirements document.

Earlier history is in [CHANGELOG.md](./CHANGELOG.md). The original product requirements (R1-R25) are in [plans/2026-10-08-1647-feat-docketry-plan.md](./plans/2026-10-08-1647-feat-docketry-plan.md). Research: [docs/research/2026-10-10-landscape.md](./docs/research/2026-10-10-landscape.md).
