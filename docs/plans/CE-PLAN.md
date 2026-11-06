---
title: Tallyline — living CE plan (cloud Linear-parity: API · web · iOS)
updated: 2026-11-04
date: 2026-11-04
decisions_locked: 2026-11-04 (wipe user keep projects; cloud API default; C1a–W1 one ce-work; Apple console TBD)
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
execution: code
scope: Hosted tallyline.app + api.tallyline.app + iOS. Self-host remains free/unlimited.
origin: session 2026-11-03/04 (SIWA identity brainstorm → undercut Linear + three-surface roadmaps)
supersedes_as_ledger: ROADMAP.md status tables for the cloud Linear-parity track only; unit specs stay in the linked plans
---

# Tallyline: plan to Linear-class cloud (API · web · iOS)

Words in **INFERRED** are design choices from the 2026-11-03/04 brainstorm, not prior shipped contracts. No secret values appear here.

## Goal Capsule

- **Objective:** One identity on Tallyline Cloud (email/password + Apple now, Google next); iOS and web feel like one product; users connect **their own** agents over hosted MCP and pay **their own** LLM bills.
- **Means:** Extend existing `auth_identities` / `resolveIdentity` / device PAT + outbox sync (Approach **A**, user-approved). Do not build a parallel Nimbus-style JWT stack. Ship SIWA before deeper Linear clone chrome when they conflict.
- **Authority:** This file is the living sequencing ledger for the cloud parity track. Deep unit specs stay in the linked plans below. Older ROADMAP “needs owner” ops items remain authoritative for backups/deploy/TestFlight gates.
- **Stop:** Do not open public signup or flip `BILLING=on` until C3 (entitlements + Stripe) is done and App Review is clear.

## 1. Inventory (what already exists in-repo)

Verified against local checkout + open GitHub plans (2026-11-04).

| Artifact | Role |
|---|---|
| [ROADMAP.md](../../ROADMAP.md) | Status ledger as of 2026-11-05; most agent-buildable U/S units **shipped**; remainder is owner ops / deferred |
| [docs/next-tasks.md](../next-tasks.md) | Ordered owner-gated handoff (TestFlight, push, deploy, backups, …) |
| [docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md](./2026-10-17-0000-feat-tallyline-full-roadmap-plan.md) | PM-ready program U1–U25 (mostly done) |
| [docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md) | Self-host + iOS S1–S7 (client mostly done; Apple/TestFlight owner-gated) |
| [docs/plans/2026-10-12-2107-feat-ios-app-plan.md](./2026-10-12-2107-feat-ios-app-plan.md) | Earlier iOS plan (superseded by S5/S6 + open #230) |
| [docs/plans/2026-10-10-1506-feat-oauth-org-identity-plan.md](./2026-10-10-1506-feat-oauth-org-identity-plan.md) | Identity / OAuth foundation (`auth_identities`, Google/GitHub/OIDC) |
| [docs/plans/2026-11-02-001-feat-app-review-demo-access-plan.md](./2026-11-02-001-feat-app-review-demo-access-plan.md) | App Review demo account + pairing notes (Guideline 2.1) |
| [docs/plans/2026-11-01-1030-feat-cloudflare-frontend-plan.md](./2026-11-01-1030-feat-cloudflare-frontend-plan.md) | Cloudflare front-end / offline Worker |
| **PR #230** `docs/ios-projects-roadmap-plan` | Full iOS/iPadOS UI/UX plan (U1–U12 shell, Now feed, projects, motion) — **merged** |
| **PR #231** `docs/intake-helpdesk-home-plan` | Public intake + helpdesk + agent-first iOS home — **merged** |
| **PR #240** `wo/intake-batch` | Intake implementation batch — **merged** |
| [docs/plans-and-usage.md](../plans-and-usage.md) + `apps/api/src/plans.ts` | Free/Team limits when `BILLING=on`; **no Stripe yet (PLAN-060)** |
| iOS today | Pairing → `tly_pat_*` → delta sync + outbox (`apps/ios/README.md`). **No SIWA.** |
| API today | Hono + Postgres; OAuth providers env-gated; MCP OAuth; device pairing; usage metering |

**Gap this plan closes:** cloud **Sign in with Apple** (web + iOS) as one identity; priced hosted offering under Linear; sequenced roadmaps for the three surfaces so ce-work has a next slice.

## 2. Current product state (2026-11-04)

| Surface | Status |
|---|---|
| **API / backend** | Production hosted API; sync, pairing, MCP OAuth, BYOK AI, intake (session-gated), entitlements code present but `BILLING` off |
| **Web** | Full tracker + settings + devices pairing (+ QR on main via #228); login = password + optional Google/GitHub/OIDC if env set; **no Apple button** |
| **iOS** | Pairing-first; offline outbox; widgets/share/shortcuts; Linear-feel UI deferred to #230; **no SIWA**; TestFlight / App Review still owner-gated |
| **Identity** | One user in prod historically; little data → wipe/reseed OK for Apple bootstrap |

## 3. Pricing (undercut Linear) + cost to serve

### 3.1 Market anchor (Linear, late 2026)

| Linear | Price (yearly billed) |
|---|---|
| Free | $0 (capped issues/teams) |
| Basic | **$10** / user / month |
| Business | **$16** / user / month |

MCP / agent platform: included; LLM for *their* agent is customer-side.

### 3.2 Tallyline Cloud list price **(INFERRED — session-settled direction: undercut Linear)**

Self-host: **$0 forever** (`BILLING` off → `self_host_unlimited`).

| Plan | List (yearly) | Monthly | vs Linear | Limits (align `plans.ts`; rename labels in product copy) |
|---|---|---|---|---|
| **Free** | $0 | $0 | Compete on free, not seats | 1 workspace, 3 seats, 3 agents, 1k agent-runs/mo (existing `free`) |
| **Pro** | **$8** / seat / mo | **$10** | Under Basic by $2 | Maps to today’s `team` limits until PLAN-060 adds a true Pro row |
| **Business** | **$14** / seat / mo | **$16** | Under Business by $2 | Same code path initially; differentiate later (SSO, audit) **INFERRED** |

**Seat = human member.** Agents / MCP connectors: count toward `maxAgents` on Free; on Pro+ included in seat price up to soft run caps. **Users bring their own LLM keys** (OpenRouter etc.); Tallyline never pays their inference.

**Not in v1 price:** metered intake volume, attachments CDN, dedicated support.

Map to code when billing ships: keep `free` / `team` IDs or migrate `team` → `pro` in PLAN-060; do not invent a third ID until Stripe is real.

### 3.3 Cost to serve (COGS estimate — **INFERRED**)

Assumes shared existing host (or one ~$40/mo VPS + Postgres + R2 backups + Cloudflare). No per-user LLM COGS.

| Cohort | What they do | Est. marginal COGS / user / mo |
|---|---|---|
| Light | Web + iOS sync, few agents, light MCP | **$0.50–2** |
| Active | Heavy MCP, webhooks, push, larger DB | **$2–8** |
| Pathological | Unbounded API/MCP abuse | Needs rate limits + Free caps (already partially present) |

**Fixed platform (order of magnitude):** $30–80/mo for a small multi-tenant box + backups before meaningful signup volume.

**Break-even sketch:** at **$8/seat** and **~$2** blended COGS → ~75% gross before support/Apple fees. Apple SIWA / Google OAuth: negligible at early scale.

**Your risk is support + abuse + DB growth**, not auth providers. Flip `BILLING=on` only with Free caps enforced and Stripe (C3).

### 3.4 MCP confirmation

Yes: cloud customers OAuth their agent to **`https://api.tallyline.app/mcp`** (workspace-scoped). Inference stays on **their** provider. You host API + MCP proxy + Postgres; you do not host their model spend.

## 4. Product Contract (cloud identity + parity slice)

### Requirements

- **R1.** One human account can sign in with password and/or Apple (Google next) on **web**; same account on **iOS** via native SIWA.
- **R2.** Successful cloud iOS SIWA mints the **same device PAT** shape as pairing redeem so outbox/delta sync is unchanged.
- **R3.** Pairing codes remain for self-host and as a fallback on cloud.
- **R4.** Apple `sub` is the stable identity key; email is metadata (relay OK). Ops may **wipe the human user / auth rows** and re-attach via SIWA; **do not delete workspace projects/issues** (re-link membership to the new or surviving user id).
- **R5.** Hosted MCP continues: users connect their own agents; BYOK AI unchanged.
- **R6.** Public pricing page states Free / Pro $8 / Business $14 (yearly) and “self-host free”; Stripe can lag copy.

### Scope boundaries

**In (near-term):** Apple provider + web button + iOS SIWA → PAT; App Review path; ROADMAP/CE sequencing; pricing copy + COGS recorded here.

**Out (near-term):** Stripe checkout (C3), Google-on-iOS until Android irrelevant, Linear feature clone for its own sake, attachments, rewriting MCP.

### Key decisions (settled)

| ID | Decision |
|---|---|
| D1 | Approach **A**: extend `auth_identities` / `resolveIdentity` (user-approved). |
| D2 | iOS parity first (user chose option 1): SIWA → workspace → Linear-feel issues/create; pairing kept for self-host. |
| D3 | Undercut Linear on list price; users BYO LLM for MCP. |
| D4 | Deep iOS UI stays in PR #230; intake in #231/#240 — this ledger sequences them **after** identity unless a PR is already mid-flight. |
| D5 | **Wipe user, keep projects** (owner 2026-11-04): clear/replace the human login identity for Apple bootstrap; **never** drop workspace projects/issues — re-link `workspace_members` (and ownership) to the post-SIWA user. |
| D6 | Cloud iOS SIWA always uses `https://api.tallyline.app`; instance URL + pairing only for self-host. |
| D7 | **One ce-work** covers C1a → C1b → I1 → W1 (API + iOS SIWA + web Apple) in one pass. |
| D8 | Apple Developer console (Services ID + iOS SIWA capability + env client IDs): **owner TBD** — code can land behind env; live TF/web Apple blocked until set. |

## 5. Three-surface roadmaps

U-IDs below are **stable for this ledger** (`C` = cloud parity). Do not renumber. Point into existing plans for detail.

### 5.1 Backend / API (`apps/api`, MCP, push-relay)

| U-ID | Milestone | Status | Done when |
|---|---|---|---|
| C1a | Apple as auth provider (JWKS / identity token verify, `provider_type` + registry + env) | ⬜ | Vitest green; `resolveIdentity` accepts Apple `sub` |
| C1b | `POST /v1/auth/apple` (or oauth callback parity) → session **and** optional device PAT mint for iOS | ⬜ | ios-contract fixtures updated; pairing redeem still works |
| C1c | Web OAuth Apple authorize/callback (Services ID) | ⬜ | `/v1/auth/methods` lists Apple when configured |
| C2 | App Review demo workspace ops (per 2026-11-02 plan) | 🟡 plan exists | Demo account + mint path proven |
| C3 | PLAN-060 Stripe + `BILLING=on` + Pro $8 / Business $14 copy | ⬜ | Checkout + portal; Free caps enforced |
| C4 | Public intake credentials (PR #231 / #240) | ✅ merged (#231, #240) | Outside apps post without human session |
| C5 | Hardening: rate limits, abuse on auth + MCP, backup owner gates (U2/U3) | 🟡 partial | owner checklist in next-tasks green |
| C6 | Write contract for both clients: idempotency keys on every mutation, `409 STALE_WRITE` carrying the server version on conflict, one documented optimistic-update shape | 🟡 in review (#256) | Web and iOS share the contract; replaying any write is a no-op; a stale write fails with a recoverable code, never a silent overwrite |

**Depends on owner:** Apple Developer Services ID + iOS App ID SIWA capability; ASC; APNs for push (S4).

### 5.2 Web (`apps/web`)

| U-ID | Milestone | Status | Done when |
|---|---|---|---|
| W1 | Login: Sign in with Apple beside password (+ Google when env set) | ⬜ | Methods from API; happy path to the owner workspace |
| W2 | Settings → Security: connected identities (Apple link status) | ⬜ | Shows linked providers; disconnect rules documented |
| W3 | Pricing / landing copy matches §3.2 | ⬜ | No Linear-beating claims we can’t deliver |
| W4 | Helpdesk + intake admin UI (#231) | 🟡 planned | Staff can manage credentials + reporter thread |
| W5 | Devices pairing kept; QR remains primary for self-host phones | ✅ | Already shipped |

### 5.3 iOS (`apps/ios`)

| U-ID | Milestone | Status | Done when |
|---|---|---|---|
| I1 | SIWA button on cloud path → C1b PAT → existing sync | ⬜ | Sign in → Issues without typing `tlpair_` |
| I2 | Pairing retained (instance URL + code/QR) for self-host | ✅ keep | Regression tests still pass |
| I3 | App Review / TestFlight (S5-U8, S7, 2026-11-02 plan) | 🟡 owner | Reviewer enters; Guideline 2.1 closed |
| I4 | Native UI plan (#230 U1–U12): shell, Now feed, projects, motion | 🟡 shell, Now feed, projects and Settings on `main` (#244 to #246, #250); closers in review (#253) | Feels first-party iOS 26; not a thin list clone |
| I5 | Agent-first home / roadmap consumption (#231 U7 / #230 U5–U6) | 🟡 planned | Opens on living work, not only flat triage |

## 6. Next execution slice (recommended order)

1. **C1a → C1b → I1 → W1** — Apple identity end-to-end (API → iOS → web). Highest leverage for “built like Linear” on the phone.
2. **C2 + I3** — App Review unblocked (demo account / notes); can parallelize with the owner.
3. **I4** — Merge/execute #230 UI plan once identity lands (or in parallel on a branch if the owner prefers chrome first — default is identity first per D2).
4. **C4 / W4 / #240** — Public intake (already moving).
5. **C6** — Write contract before hardening, so every mutation path has one idempotency and conflict story.
6. **W3 + C3** — Public pricing + Stripe when ready to take money.
7. Continue owner ops from [docs/next-tasks.md](../next-tasks.md) (backups, deploy user, push relay, S2 publish).

## 7. Planning Contract (KTDs)

| KTD | Choice | Why |
|---|---|---|
| KTD1 | Reuse device PAT after SIWA | Sync/outbox/share extension already assume `tly_pat_*` |
| KTD2 | Verify Apple **identity token** on API (JWKS), not only ASAuthorization on device | Server is source of truth (same as Nimbus pattern, Tallyline identity table) |
| KTD3 | Env: `APPLE_CLIENT_ID` (Services ID for web) + iOS bundle as audience(s) | Mirror Google env style in `registry.ts` |
| KTD4 | Bootstrap: wipe/replace **user** auth as needed; preserve workspace + projects/issues; re-link membership after SIWA | D5 |
| KTD5 | Pricing copy can ship before Stripe; enforcement stays off until C3 | Avoid charging without rails |

## 8. Verification Contract

| Gate | Command / check |
|---|---|
| API unit | `pnpm --filter @tallyline/api exec vitest run` (auth + identity + ios-contract) |
| Identity | New Apple provider tests with fixture JWKS / stub IdP (no network) |
| iOS core | `TALLYLINE_CORE_ONLY=1 swift test` in `apps/ios` |
| Web | `pnpm --filter @tallyline/web typecheck` + login e2e when Apple test mode available |
| Manual | Cloud: SIWA on phone → owner issues visible; web Apple login same user; pairing still works against self-host URL |
| Billing (later) | With `BILLING=on`, Free hits 402 at seat/agent caps; Pro checkout grants `team`/`pro` |

## 9. Definition of Done (this track’s v1 “Linear-class enough”)

Status 2026-11-05 (readiness pass): no box is checked yet. The cloud beta units are partly in review (#256, #255, #253) and nothing is deployed or device-verified. See the Readiness pass section in [docs/next-tasks.md](../next-tasks.md).

- [ ] Web + iOS Apple sign-in → same user → same workspace data.
- [ ] iOS sync (delta + outbox) works without pairing on cloud.
- [ ] Pairing still works for self-host.
- [ ] MCP: external agent connects with user OAuth; LLM is BYOK.
- [ ] Pricing page undercuts Linear (§3.2); self-host free.
- [ ] App Review path documented and usable (C2/I3).
- [ ] COGS assumptions revisited after first 50 paying seats.

## 10. Risks

- Apple Hide My Email / missing email → rely on `sub` + bootstrap (KTD4), not email merge.
- App Review still blocked on pairing TTL until C2 or SIWA ships.
- Executing #230 and C1 in one PR = thrash; sequence per §6.
- Opening signup before C3 = unbounded COGS on Free.

## 11. Open questions

**Blocks live Apple (not code start):**

- **OQ4.** Apple Developer: enable Sign in with Apple on App ID `app.tallyline.ios` (or current bundle), create Services ID for web (`tallyline.app` / `api.tallyline.app` return URLs), put client id(s) in prod env. Owner: not sure yet — check ASC / developer.apple.com when ready.

**Non-blocking for C1 code:**

- OQ1. Exact Stripe product IDs / annual discount mechanics (C3).
- OQ2. Whether Business is a real second Stripe price or just Pro + flags at first.
- OQ3. Merge #230 before or after first SIWA TestFlight (default: after I1; #230 still excludes SIWA).

## 12. Appendix — deferred from older ROADMAP (unchanged triggers)

Loops, skills registry, WordInk intake, multi-workspace hardening, templates, virtualization, ChatGPT shared provider (S3-U5) — see original Deferred ledger in the 2026-10-17 plan.
