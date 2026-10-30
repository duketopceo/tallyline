---
title: Kate Monetization and Growth - Plan (U16+)
type: feat
date: 2026-10-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
addendum_to: docs/plans/2026-10-15-2155-feat-kate-production-launch-plan.md
deepened: 2026-10-16
---

# Kate Monetization and Growth - Plan (U16+)

**Target repos:** `duketopceo/kate` (backend, this repo) and `duketopceo/kate-ios` (iOS). Paths prefixed `ios:` are in kate-ios; all others are in kate. This plan is an addendum to the production launch plan (U1-U15, mostly merged). It numbers units from U16 (U27-U32 added by the growth deepening pass) and reuses that plan's KTDs, verification contract and the U15 production gate.

---

## Goal Capsule

- **Objective:** Kate can charge for Plus on the hosted service, with every hosted crew under the plan limits, Luke's own crew free forever by an explicit owner tier, self-hosting free and guided, and first-party anonymous numbers that show where people drop out of the funnel.
- **Means:** An owner tier plus an invariant that no other crew is ever grandfathered (U16). One entitlement model fed by StoreKit 2 and App Store Server Notifications, and by Stripe web checkout and Stripe webhooks (U17, U20). A read-only lapse path that never deletes data (U18). Install-scoped anonymous funnel events in D1 on the U6 pattern, reported on the U8 triage page and digest (U19, U21, U22). A paywall with moments, an annual-default picker, an intro offer and downsell offers (U23, U24). A hidden but working, fully guided bring-your-own server path (U25). A release gate that extends U15 (U26). Growth and retention units that earn their place: a first-value activation metric and in-app nudges (U27), a closed-vocabulary cancel-reason prompt (U28), honest Founding Crews scarcity (U29), gift, referral and affiliate codes (U30), a no-AI Year in Review (U31), and a landing page with an isolated Meta Pixel and Conversions API for the Meta test (U32).
- **Launch slice:** the minimum unit set before the 2026-10-26 GTM start is listed under Sequencing. Spend of any kind starts only after App Store approval and Plus live.
- **Authority:** Luke's decisions below are settled and are not reopened by any unit. Product Contract and KTDs here win over unit text. The launch plan's KTD8 (`isPlusEnabled` is the one Plus gate) and R13 (licensing precondition) stay in force.
- **Execution profile:** One PR per unit per repo, merged only after the checks for the merge result pass in a separate command (launch plan KTD9). Purchase surfaces (Stripe, paywall, offers, codes, Founding Crews, Year in Review) ship inert while `KATE_PLUS_ENABLED` is off and the iOS `KATE_PLUS` flag is not compiled in; plan limits (U16), analytics (U19, U21, U22) and BYO hiding (U25) are controlled by `KATE_HOSTED_PLANS`, `growth_enabled` and the app release, and go live through the U15 gate. No production deploy or migration happens outside the U15 gate (see U26).
- **Stop conditions:** Stop and ask Luke if a unit would put any TMDB-derived field in a paid feature, an analytics event or a model input, or would put the Meta Pixel, the Conversions API or any third-party tracker in the app. Stop if Apple or Stripe policy text found while executing contradicts a settled decision (record it under Open Questions). Stop if a production read shows a crew other than `default` on tier `grandfathered`, or if any cost alert fires.
- **Who finishes:** Claude executes U16-U32 and the backend deploys that pass the U15 gate. Luke creates everything in "Luke actions" below.

---

## Product Contract

### Summary

Hosted Kate stays free up to FREE_LIMITS and sells Kate Plus (PLUS_LIMITS and non-TMDB extras) per crew, paid by the crew owner. Payment is StoreKit 2 in the app (primary) plus Stripe web checkout in the US (secondary, linked from the app only where the storefront rules allow). One server-side entitlement answers "does this crew have Plus" regardless of source. Self-hosters connect their own server for free. Growth is measured with anonymous install-scoped events that never name a person.

### Settled decisions (Luke, 2026-10-16; not reopened)

- D1. "we need to control all crews." Every hosted crew is subject to the plan limits. Luke's crew (prod id `default`, "Luke & Kate", today `grandfathered`) is free forever through an explicit owner/comp tier. The `grandfathered` tier is never assigned to any other crew. Prod today: 2 crews, `default` (grandfathered) and one test crew on `free`.
- D2. BYO server (Settings > Advanced > Switch server): keeps working, is hidden, is free (costs us nothing), and has a fully guided setup (deploy, connect, verify) in the app and on a docs page.
- D3. Payments: "In-app + web checkout". StoreKit 2 is primary. A US Stripe web checkout (Apple Pay on the web) is linked from the app only where US storefront rules allow external purchase links. One entitlement model reconciles App Store Server Notifications and Stripe webhooks.
- D4. Upsell and downsell: paywall at limit hits and feature gates; annual-default picker with monthly; an intro offer; a downsell on paywall dismiss or cancel (monthly or discounted offer via StoreKit promotional or win-back offers, and Stripe coupons); a clean downgrade when Plus lapses, data kept read-only and never deleted.
- D5. Analytics are first-party and anonymous like U6: install-scoped events in D1, not linked to the person, no third-party SDK. Funnel: install, sign-up started, account created, crew created, first entry, invite sent, invite accepted, paywall viewed, purchase started, purchase completed, renewal or cancel. Reports go on the U8 triage page and the daily digest. Privacy labels and the privacy page are updated (Usage Data, not linked).
- D6. Hard constraints: TMDB data is never in anything paid and no AI processes TMDB data (so Plus extras never include a movie or TV row or a TMDB-derived figure); Plus gating stays in `src/lib/plus/config.ts` (`isPlusEnabled`); no production deploy or migration without the U15 gate; Stripe keys, the Stripe account and App Store Connect products and offers are Luke's to create; no paid model calls, subagents use Sonnet, deterministic tests on self-hosted runners; no claude.ai artifacts.

### Findings from existing code that shape the units

- `src/lib/limits/limits.ts` `limitsForCrew` reads `crews.limits_tier` (`free` | `grandfathered`, migrations 0044) and `crewHasPlus` (migration 0046 tables `subscriptions`, `crew_plans`, `asn_events`). Grandfathered gets unlimited storage and video count with the *free* per-file caps, even on Plus. `src/lib/crew.ts` lines 153 and 198 insert the lazily created `default` crew as `grandfathered`.
- `limitsForCrew` has no hosted-versus-self-hosted switch. A second crew on a self-hosted server would get FREE_LIMITS today. D2 (BYO is free) therefore needs a deployment flag, added in U16.
- Plus is wired end to end on the server (`/api/v1/plus/status`, `/plus/verify`, `/api/appstore/notifications`, `bindTransaction`, JWS verification) and in `ios:Sources/kate_ios/Plus/` (`PlusStore`, `PlusView`, `KateCore/Plus.swift`), compiled only with `KATE_PLUS=1`. The paywall today is a single Settings > Crew > Kate Plus screen with product list and Restore; there are no limit-hit or feature-gate moments, no offers, no analytics, no web path.
- `FREE_LIMITS.maxMembers` is 6 and `PLUS_LIMITS.maxMembers` is 12 (`src/lib/limits/limits.ts`), and `getMaxMembers` in `src/lib/crew.ts` raises a crew's stored cap to the Plus value while the crew has Plus. So Plus already differs from Free on member capacity. Neither constant set has an owned-crews limit, and nothing in `src/lib/plus/` gates book export or AI recaps: those appear only in the 005 plan's Crew Plus list, and `src/lib/plus/features.ts` does not exist yet (U23 creates it).
- Limit refusals already carry `error` and `limit` (`src/lib/limits/refusal.ts`; iOS `ErrorCatalog` maps `quota_exceeded` to a park-in-outbox message). That is the hook for limit-hit paywall moments.
- U6 pattern to reuse for analytics: `src/lib/diagnostics/{store,scrub}.ts`, `withinRateLimit` budgets per day (main, server, anon), `hashIp`, an allowlist scrubber, route exempt from the kill switch, 30-day purge in `worker.ts`, and `ios:Sources/KateCore/DiagnosticsUploader.swift` with a Keychain install id. U8 owns the triage page and digest.
- The Switch server row is `SettingsRow.switchServer` in `ios:Sources/KateCore/Shell.swift` (`advancedRows`) rendered in `ios:Sources/kate_ios/Settings/SettingsView.swift`; the sign-in screen has a "Using your own Kate?" link. `docs/self-host.md` and `src/app/(public)/self-host/page.tsx` already describe deployment.
- The 005 plan (`docs/plans/2026-10-12-005-...`, 4.2) recommends $3.99 monthly and $29.99 yearly with a 7-day trial on yearly, 15% Apple commission, lapse = read-only for uploads with a 30-day grace and never deletion. These are the proposed defaults here; Luke confirms prices when creating products.

### Requirements

- R30. Every hosted crew resolves to exactly one tier in `free | owner`, plus time-bound Plus. `grandfathered` is a legacy value no code or SQL can assign, and `owner` can only be held by the crew id `default`; D1 triggers and a preflight check enforce both. (D1)
- R31. The `default` crew is on tier `owner`: unlimited storage and video count, Plus per-file caps, no payment ever asked of it. It never shows a paywall. (D1)
- R32. Limits apply only when the deployment is the hosted service (`KATE_HOSTED_PLANS` on). A self-hosted server applies no plan limits and shows no Plus UI. (D1, D2)
- R33. One entitlement store answers Plus for a crew from either Apple or Stripe. A crew never has two active paid sources: the second purchase is refused with `plan_already_active`, and a race is alerted, not silently stacked. (D3)
- R34. Stripe checkout, portal and webhooks exist only behind `isPlusEnabled`, and checkout and portal sessions are created only for the crew owner. The app shows the web option only for a US storefront and only when the compiled and server flags allow it. (D3, D6)
- R35. A lapsed crew keeps every byte readable and exportable and can delete; only new uploads beyond FREE_LIMITS are refused, after a 30-day grace that starts at a natural lapse (a full refund or lost dispute has no grace). Members are never removed: a lapsed crew above its stored member cap keeps every member and refuses only new joins with the existing `crew_full` copy. Nothing is deleted by lapse. (D4)
- R36. Paywall moments exist at each limit refusal (storage, videos, file size, video length, members) and each Plus feature gate; every paywall has a dismiss path, which can show one downsell. (D4)
- R37. The plan picker defaults to yearly, shows monthly, and presents the intro offer when the user is eligible. (D4)
- R38. Analytics events carry an install id and no person, crew, title, place, name or text. Server stores only a salted hash of the install id. A Settings toggle turns reporting off. (D5)
- R39. Funnel and paywall reports appear on the triage page and in the digest, never summarized by a model. (D5, D6)
- R40. BYO connection is absent from default Advanced rows, reachable by a documented reveal, and a guided flow (deploy, connect, verify) exists in the app and in `docs/self-host.md` plus the public self-host page. (D2)
- R41. No analytics event, paywall copy, Plus feature or AI input includes TMDB-derived data. Plus features that call a model exclude movie rows. (D6)
- R42. The north-star activation metric is a crew whose invite is accepted within 48 hours of crew creation and that then has a first shared entry. It is computed from operational tables at report time and reported as counts only; no new identifier or column stores it. The app nudges toward it with local reminders that the person can turn off. (D5)
- R43. When Plus lapses or a Stripe subscription is cancelled, the owner can give one optional reason from a closed list (`reason_price`, `reason_not_using`, `reason_missing`, `reason_other`) with a single tap. No free text, no required answer, no obstacle to leaving. (D4, D5)
- R44. "Founding Crews" is a real, server-side counter: the first N annual subscribers keep their annual price while they stay subscribed. The count shown in the app comes from the server, never from a client constant or a timer, and a spot freed by a full refund is reopened. (D4)
- R45. Gift, referral and affiliate codes are Apple offer codes and Stripe promotion codes created by Luke. Redemptions are counted first-party by campaign key from a closed table, with no person, crew or code string stored. (D3, D4, D5)
- R46. Plus includes a Year in Review layout and PDF built on the device from crew-written content only (entries, photos, walks, plans), with no AI and no movie, TV or other TMDB-derived row or figure. Raw data export is never gated. (D6)
- R47. The Meta Pixel and Conversions API run only on the marketing landing page, on its own origin, after consent. They appear nowhere in the app or the Worker that serves the API. The website privacy policy discloses them and the app's privacy label does not change. (D5, D6)
- R48. Every paywall, offer and founding-spot surface meets App Store guideline 3.1.2: price, period and renewal terms are shown, trial terms state the price that follows, no decoy tier, no penalty trial, no countdown that resets, no scarcity claim that is not true, and Terms, Privacy and Restore are visible. (D4)

### Acceptance Examples

- AE10. Covers R30, R31. After the owner-tier migration (U16, 0056) the `default` crew reads `limits_tier = 'owner'`, the test crew reads `free`, and `UPDATE crews SET limits_tier = 'grandfathered'` fails.
- AE11. Covers R32. A server started without `KATE_HOSTED_PLANS` lets a second crew upload past 1 GB.
- AE12. Covers R33. An owner with an active Apple subscription who requests a Stripe checkout session gets 409 `plan_already_active` and no session.
- AE13. Covers R35. A crew whose Plus lapsed 10 days ago at 3 GB can list, export and delete, and its next upload returns 402 `quota_exceeded` with the `plan` hint only after day 30.
- AE14. Covers R37. A first-time US owner opening the paywall sees yearly selected with the trial line, and monthly one tap away.
- AE15. Covers R38. A posted event containing `crewId`, `title` or any field outside the allowlist stores none of it.
- AE16. Covers R40. With the Switch server row hidden, a person who follows the docs page deep link reaches the guided connect flow and gets a green "your server is ready" check.
- AE17. Covers R42. Seeded crews A (invite accepted at hour 30, entry on day 2), B (accepted at hour 60) and C (no invite) give an activation rate of 1 of 3 for the day cohort, and the report stores no per-crew row.
- AE18. Covers R43. A lapsed owner taps "Not using it" once; `growth_daily` gains `cancel_reason` / `reason_not_using` +1, the prompt never shows again for that lapse, and dismissing it changes nothing about access.
- AE19. Covers R44. With cap 100 and 100 claimed, the 101st annual purchase gets no founding claim and the app shows no spots; a full refund of claim 37 reopens one spot and the next annual buyer gets rank 37's slot as a new claim.
- AE20. Covers R45. A Stripe checkout paid with promotion code `AFF_X` and an Apple transaction with offer identifier `aff_x` each add 1 to `code_redeemed` / `aff_x`; neither the code string nor a crew id is stored with the count.
- AE21. Covers R46. A crew with 40 entries, 120 photos, 6 walks and 12 movie ratings gets a Year in Review PDF whose pages carry the first three and none of the movie ratings.
- AE22. Covers R47. A scan of the app sources, the iOS bundle and the API Worker bundle finds no `fbq`, `connect.facebook.net` or Conversions API call, and the landing page fires neither before consent.

### Success Criteria

- Plus is purchasable in sandbox and Stripe test mode, every paid path ends in the same `crew_plans` state, and a lapse leaves data intact.
- The digest shows yesterday's funnel counts from install to purchase and the paywall-moment breakdown.
- No migration or deploy happens outside U15.

### Scope Boundaries

- No automated referral reward ledger (codes are Luke-issued campaigns, R45), no lifetime tier, no Family Sharing, no per-seat pricing, no team or enterprise plan, no higher "Family" tier until crews are seen hitting 12 members.
- No third-party analytics or attribution SDK in the app; no IDFA; no App Tracking Transparency prompt. The landing-page Pixel (R47) is website advertising measurement on a separate origin, outside the app's D5 analytics.
- Considered and not built: AI recaps of private journal text (weakens the private-by-construction claim; revisit only as an opt-in per recap), a decoy or higher-priced anchor tier, a setup fee or penalty trial, a pricing change from the Q2 defaults before 100 paywall views, email capture on the landing page, joining a landing visit to an install (App Store Connect campaign links give install counts), a credits screen naming founders (needs personal data; badge only), a rename (Hormozi-style naming is a launch-read decision for Luke, not a unit).
- No change to Plus pricing amounts beyond configuring Luke's chosen values.
- No new TMDB usage; Plus never advertises movie features (R41).

### Deferred to Follow-Up Work

- Android or web-app purchase, automated referral rewards, Apple promotional-offer signing (the `.p8` key route, see U24), email lifecycle campaigns, more owned crews as a Plus gate, a Trail Pack or priority-support bonus, Stripe Tax beyond US, additional currencies, experiments with more than one downsell variant.

**Apple promotional-offer signing (moved out of U24 by the Q3 proposal; returns only if Luke picks promotional offers).** A Worker route `src/app/api/v1/plus/offer-signature/route.ts` that returns key id, nonce, timestamp and a base64 DER ECDSA signature over the StoreKit payload (bundle id, key id, product id, offer id, lowercase `appAccountToken`, nonce, timestamp, joined by U+2063; WebCrypto returns raw r||s so the route converts to DER), refusing unknown offers, non-owners and active crews, with a server-side once-per-N-days record, a fresh nonce and a short timestamp window, and secrets `APPSTORE_IAP_KEY_P8`, `APPSTORE_IAP_KEY_ID`, `APPSTORE_IAP_ISSUER_ID` read only inside the route. Tests: pinned payload fixture, DER-parse check, deterministic fixture key.

### Open Questions

- Q1 (Luke, before U23 enables the web option): confirm that Apple's current US storefront rules (post the 2025 court ruling) allow a plain external link to web checkout without a special entitlement or commission-reporting duty. Executing U23 re-reads Apple's current guideline 3.1.1 and 3.1.3 text and records the quote and date in `docs/release-checklist.md`; if it contradicts D3, stop and report.
- Q2 (Luke, at product creation): final prices and trial length; defaults are $3.99 monthly, $29.99 yearly, 7-day yearly trial.
- Q3 (downsell) **proposed — awaiting Luke's confirmation.** Proposal from the Hormozi playbook (change structure first, price second): on paywall dismiss show the monthly plan, which needs no signing; for lapsed Apple owners use Apple win-back offers configured in App Store Connect (no server signing); for Stripe buyers apply a 3-month repeating coupon once per crew. A 50%-off-first-year promotional offer is dropped: it cannot reach never-subscribed dismissers, and a halved first year doubles the price at renewal. With this proposal U24's offer-signature route and the `.p8` key move to follow-up work. U24, the Stripe coupon in U20 and Luke actions 5, 14 and 21 stay blocked until Luke confirms; if Luke picks promotional offers instead, the signing design under Deferred to Follow-Up Work returns to U24.
- Q4 (Luke, **still open**): `KATE_HOSTED_PLANS` defaults off, so a hosted deploy missing the var silently uncaps every crew. This plan keeps the default (it keeps existing self-hosters uncapped without a config change) and guards with the deployed `hostedPlans` health field, the preflight read and the production smoke test. The inverse (limits on unless `KATE_SELF_HOSTED` is set, which would cap existing self-hosters until they add the var) is safer against a hosted slip. Choose before U16.
- Q5 (what Plus gates) **proposed — awaiting Luke's confirmation.** Capacity limits (storage, videos, video length, per-file caps, 12 members versus 6) plus one outcome feature, a no-AI Year in Review layout and PDF (U31). Never gate invites, search, viewing, export, delete or the first-value path (invite, first entry, partner joining), and no AI recaps of private journals. More owned crews stays out (cheap to serve but low value; Deferred). U31 and the `gate_year_in_review` paywall variant stay blocked until Luke confirms; until then U23 ships limit-hit moments only.
- Q6 (parity and cadence) **proposed — awaiting Luke's confirmation.** The same prices on web and in-app ($3.99 and $29.99 unless Q2 changes them), and a 30-day review after launch with no numeric success targets until the first month of data; the GTM go/no-go gates are for tuning, not targets, and price or paywall changes wait for at least 100 paywall views. Luke action 14 (Stripe prices) waits on this; code reads price ids from config and does not depend on it. Also open: how a free-crew owner learns a member hit a limit, since only the owner can buy (the playbook's pre-written one-tap "Ask <owner>" message is a candidate for U23).
- Q7 (Founding Crews terms) **proposed — awaiting Luke's confirmation.** A cap of 100 annual subscribers; the benefit is an annual price that does not rise while the subscription stays continuous (a lapse beyond the 30-day grace ends the lock) plus a "Founding Crew" badge in the owner's Plus screen; the offer closes at the cap or at a fixed announced date, whichever comes first; Apple price rises use "preserve current price for existing subscribers", which covers all existing subscribers and so is not founder-exclusive, and Stripe founders stay on their original price id; the founder-specific parts are the badge, the real spot count and Luke's pledge, and Luke should confirm that is enough of a perk. U29 stays blocked until Luke confirms the cap, the perks and the end date.

---

## Planning Contract

### Key Technical Decisions

- KTD10. **Tier is the crew's standing, Plus is time-bound, and they never share a column.** `crews.limits_tier` becomes `free | owner` (the schema enum keeps `grandfathered` only so old rows parse). `limitsForCrew` returns: owner = PLUS_LIMITS per-file caps with unlimited storage and video count, regardless of Plus; free = FREE_LIMITS or PLUS_LIMITS by `crewHasPlus`. SQLite `BEFORE INSERT/UPDATE` triggers raise if any row is set to `grandfathered`, or to `owner` with an id other than `default`, so the invariant holds even for a raw SQL slip. `owner` is written only by the migration and by the lazy creation of the crew whose id is `default` in `src/lib/crew.ts`; no API route can set or change it, and there is no comp tooling for any other crew. (D1)
- KTD11. **Limits are a hosted-service behavior.** `KATE_HOSTED_PLANS` (same truthy set as other flags) is set only in the hosted `wrangler.jsonc`. Off means `limitsForCrew` returns an uncapped set and `/plus/status` says unavailable. This is the mechanism that makes BYO free without a special case per self-hoster. Because a missing var would uncap every hosted crew, the deployed Worker reports `hostedPlans` on `/api/v1/health` and U26's production smoke test asserts it is true and that a new free crew is capped; preflight reads the deployed value, not only the config file (see Open Question Q4). It lives next to `isPlusEnabled` in `src/lib/plus/config.ts` so there is still one place to read plan flags. (D1, D2, D6)
- KTD12. **One entitlement store, namespaced ids, no FK rewrite.** `subscriptions` gains `source` (`apple` | `stripe`, default `apple`); a Stripe subscription is stored with `original_transaction_id = 'stripe:<sub_id>'` (Apple ids are numeric, so no collision), so `crew_plans` and `crewPlanState` keep working unchanged and `entitled()` stays the single time-based rule. Source-specific mappers produce the same `Entitlement` shape. One crew has one `crew_plans` row; binding a second source while the first is entitled returns 409 `plan_already_active`. If a race still produces two active sources, the one that expires later backs the crew and an alert row tells Luke to refund the other. A bind refused with `plan_already_active` is different: the Stripe webhook cancels and refunds it automatically (U20 step 3a); only the both-succeeded race is left to the alert row and a manual refund. (D3)
- KTD13. **Stripe is called with `fetch`, verified with WebCrypto, no SDK.** The Worker creates Checkout Sessions (mode `subscription`, `client_reference_id = crewId`, metadata `userId`, `crewId`), Billing Portal sessions, and verifies the `Stripe-Signature` header (HMAC-SHA256 over `t.payload`, 5 minute tolerance, constant-time compare). An event id is recorded in `asn_events` (column `source` added) in the same D1 batch as the entitlement write, or only after the bind succeeds, so a failed bind stays retryable. Subscription events are triggers: the handler fetches the current subscription object from the Stripe API and maps that state, which removes the one-second `created` ordering problem. Events whose `livemode` differs from the configured key mode, or whose price id is not in the configured price allowlist, are ignored without writing. Mapping: `trialing`/`active` active, `past_due` grace of 3 days from the failed invoice (not from the already-advanced current period end), `canceled`/`unpaid`/`incomplete_expired` expired, a full refund or a lost dispute (`charge.dispute.closed`, status lost) revoked; a partial refund changes nothing. (D3)
- KTD14. **Lapse is a derived state, not a mutation.** `lapsedAt` is the earlier of the stored `expires_at` (or `grace_expires_at`) and any `revoked_at`, and the 30-day grace applies only to natural expiry, never to a refund or lost dispute; read-only-over-cap is computed at request time from `crew_usage` against FREE_LIMITS and `now - lapsedAt > 30 days`. No cron deletes or flips anything, so a resubscribe or a late notification heals state without repair. Refused uploads use the existing 402 envelope plus a `plan` hint field. (D4)
- KTD15. **Analytics are counters plus per-install first-seen rows, both anonymous.** `growth_daily(day, step, build, variant, count)` answers volumes; `install_steps(install_hash, step, first_day)` answers funnel conversion per install (a step is stored once per install, so the table is bounded by installs times 11). `install_hash = sha256(KATE_IP_SALT-derived salt + installId)`, never the raw id, never joined to users or crews. Steps that happen server-side without an install id (renewal, cancel, refund) are counted into `growth_daily` only, from the entitlement writers, with no install row. Budgets mirror KTD5: new install rows per UTC day, per-install and per-IP caps, with counts still incrementing past the row budget. 90-day purge of `install_steps`. (D5)
- KTD16. **Event vocabulary is a closed enum, with an allowlisted `variant`.** Steps: `install`, `signup_started`, `account_created`, `crew_created`, `first_entry`, `invite_sent`, `invite_accepted`, `paywall_viewed`, `purchase_started`, `purchase_completed`, `renewal`, `cancel`, `cancel_reason`, `code_redeemed`. Variants: paywall moment (`limit_storage`, `limit_videos`, `limit_file`, `limit_length`, `limit_members`, `gate_<id>`, `settings`, `downsell`, `winback`, `founding`), source (`apple`, `stripe`), plan (`monthly`, `yearly`), cancel reason (`reason_price`, `reason_not_using`, `reason_missing`, `reason_other`), and a code campaign key (`code_<key>`). `renewal`, `cancel` and `code_redeemed` are server-only steps the client scrubber rejects. `purchase_completed` has two writers that never share a counter: the client post (variant `apple` or `stripe`, unverified) writes only to `install_steps` for the per-install funnel, and the server bump on a first successful bind writes only to `growth_daily` with a combined variant (`apple_monthly`, `apple_yearly`, `stripe_monthly`, `stripe_yearly`), so purchases and revenue come from the server count. `purchase_started` carries the paywall moment as its variant so paywall-to-purchase by moment is computable. `code_redeemed` variants are validated against the campaign table in `src/lib/plus/codes.ts`. Anything else is rejected, so titles or ids cannot be smuggled in. (D5, D6)
- KTD17. **Paywall is pure KateCore logic with a thin SwiftUI shell.** `PaywallPlanner` in KateCore decides moment, default plan, intro eligibility, downsell and web-link visibility from plain inputs (entitlement, storefront country, eligibility flags), so every decision is a Linux `swift test`. StoreKit calls stay in `kate_ios` behind `KATE_PLUS`. (D4)
- KTD18. **Downsell uses no client-decided and no server-signed Apple offer (Q3 proposal).** On dismiss the app shows the monthly plan, an ordinary product in the same subscription group. Win-back offers are configured in App Store Connect and surfaced by StoreKit for lapsed subscribers, so nothing is signed by Kate. Stripe coupons (3-month repeating, once per crew) are attached server-side by a coupon id from config, only when the user came through the downsell variant, and the once-per-crew marker is server-side. Offer ids and coupon ids live in `src/lib/plus/offers.ts`, one table. Promotional-offer signing is Deferred to Follow-Up Work. (D4; blocked on Q3.)
- KTD19. **Plus extras never touch TMDB.** The feature-gate list (`src/lib/plus/features.ts`) is a short allowlist (higher limits and, under the Q5 proposal, Year in Review). Movie rows, TV rows, recommendations, streaming data and any figure derived from them (hours watched, ratings of titles) are excluded from every paid path by row type, with a test. No AI recap feature is built, so there is no model input to filter; if one is ever added it is opt-in per recap and excludes movie rows by the same type filter. (D6)
- KTD20. **BYO is hidden by default and disclosed.** The Switch server row leaves `advancedRows`; it appears when `SettingsFlags.byoServerRevealed` is set by tapping the version row five times, or by opening `kate://connect?server=<https url>` (the docs page links it). The sign-in screen link is also hidden behind the same reveal. App Review notes disclose the feature, its reveal and that it needs no payment. A deploy-connect-verify flow checks `/api/v1/health` (`schemaReady`), the setup key and the app's minimum server version before switching. (D2)
- KTD21. **Activation is computed at report time from operational tables, never stored.** The cohort is crews created on a day; a crew is activated when a second member joined within 48 hours of creation (join time is `crew_members.created_at`; `invites` carries no accepted-at column) and a journal entry exists that was created after that join. The report returns counts and a rate, and no per-crew row, flag or id leaves the query. This keeps D5's anonymity (no crew id in any analytics table) and adds no write path. The per-install client steps (`invite_sent`, `invite_accepted`, `first_entry`) stay for per-install drop-off and are not the metric. (D5)
- KTD22. **The founding counter is one D1 table written in the same batch as the first annual bind.** `founding_crews(crew_id primary key, rank, claimed_at)` with `rank` unique in 1..cap; the insert is `INSERT OR IGNORE ... SELECT` that takes the lowest unused rank, guarded by `count < cap`, inside the batch, so two simultaneous binds cannot exceed the cap, a freed middle rank is reused, and a rank conflict makes the claim a no-op that can never abort the paying customer's entitlement write. A full refund or revocation deletes the row, which reopens the spot, so the displayed count is always true. `GET /api/v1/plus/founding` returns `{ cap, claimed, open, endsAt }` and the app renders only that; there is no client timer. The price lock is Luke's pledge that a founder's annual price does not rise while the subscription stays continuous. Apple's "preserve current price for existing subscribers" applies to all existing subscribers, not a chosen subset, and Stripe founders simply stay on their original price id, so the lock is delivered by those settings but is not exclusive to founders; copy therefore never says others will pay more, and the founder-specific parts are the badge and the real spot count. (D4, Q7)
- KTD23. **Codes are campaigns in one closed table.** `src/lib/plus/codes.ts` maps an Apple offer identifier or a Stripe promotion code id to a campaign key (`gift`, `referral`, `aff_<slug>`). Apple redemptions arrive as the `offerIdentifier` and `offerType` already present in App Store Server Notifications; Stripe redemptions arrive in the checkout session's discount. Only the campaign key is counted (`code_redeemed` in `growth_daily`), never the code string or the crew. Unknown identifiers are counted under no key and logged. Apple offer codes are redeemed through the App Store or StoreKit's redeem sheet, shown as a "Have a code?" row on the Plus screen and not as a paywall downsell. (D3, D4, D5)
- KTD24. **Year in Review is built on the device from crew-written rows by type.** The selection is deterministic (counts, month with most photos, longest walk, first entry of each month), computed in KateCore from entries, photos, videos, walks and plans, and rendered with SwiftUI to a PDF on the device. Rows of type movie or TV are dropped by type before the selection runs, so no TMDB-derived figure can appear. It reuses the pure-Swift aggregation of the Insights plan (`2026-10-13-004`) where that has merged, minus its hours-watched cards. No server cost and no data leaves the device. (D6, Q5)
- KTD25. **The marketing site is its own origin.** The landing page is a small static site in `marketing/` deployed as its own Cloudflare project on the landing domain (Luke's choice), so the Pixel never shares an origin, cookie scope or CSP with the app or API Worker. The Pixel and a Conversions API relay load only after a consent choice. The relay sends `PageView` and one "Get Kate" click event with the same `event_id` as the Pixel for dedupe, plus the user agent and IP Meta requires, and nothing from Kate's database. A repo test fails if Pixel or Conversions API strings appear in `src/`, the iOS target or the API Worker bundle. (D5, D6, Option B in the GTM plan)

### Units overview

| U-ID | Title | Key files | Depends on | Blocked on |
|---|---|---|---|---|
| U16 | Owner tier, grandfather invariant, hosted-plans flag | `drizzle/migrations/0056_*`, `src/lib/limits/limits.ts`, `src/lib/plus/config.ts` | none | Q4 (before starting) |
| U17 | Unified entitlement model | `src/lib/plus/entitlement.ts`, `drizzle/migrations/0057_*` | U16 | none |
| U18 | Lapse and read-only downgrade | `src/lib/limits/*`, `src/app/api/v1/plus/status/route.ts` | U16 (shows `source` once U17 lands) | none |
| U19 | Growth analytics backend | `src/lib/growth/*`, `drizzle/migrations/0058_*` | U16 | none |
| U20 | Stripe web checkout and webhooks | `src/lib/plus/stripe/*`, `src/app/api/v1/plus/checkout` | U17, U19 | Q1 before the web option is shown; Q3 for the coupon parameter |
| U21 | iOS growth events and privacy | `ios:Sources/KateCore/Growth*`, privacy docs | U19 | none |
| U22 | Triage funnel, activation and code report, digest | `src/app/(admin)/triage`, `src/lib/diagnostics/digest.ts` | U19, U8 (merged) | none |
| U23 | Paywall v2: moments, picker, intro, disclosures, web link | `ios:Sources/KateCore/Paywall*`, `ios:Sources/kate_ios/Plus/*` | U18, U21; U20 for the web link only | Q5 for `gate_<id>` variants |
| U24 | Downsell (monthly on dismiss, win-back, Stripe coupon) | `src/lib/plus/offers.ts`, `ios:Sources/kate_ios/Plus/*` | U23; U20 for the coupon | Q3 |
| U25 | BYO server: hide and guided setup | `ios:Sources/KateCore/Shell.swift`, `docs/self-host.md` | U16 | none |
| U26 | Monetization release gate, spend gate and Luke checklist | `docs/release-checklist.md`, `scripts/ops/preflight.sh` | the launch slice, U15; every other unit merged dark or deferred | all open Questions that gate a unit being switched on |
| U27 | First-value activation nudges | `ios:Sources/KateCore/Nudges.swift`, `ios:Sources/kate_ios/Nudges/*` | U21, U22 | none |
| U28 | Cancel-reason prompt | `ios:Sources/kate_ios/Plus/*`, `src/app/(public)/plus/return/page.tsx` | U19, U21, U23; U20 for the Stripe path | none |
| U29 | Founding Crews | `drizzle/migrations/0059_*`, `src/lib/plus/founding.ts`, `ios:Sources/kate_ios/Plus/*` | U17, U19, U23 | Q7 |
| U30 | Gift, referral and affiliate codes | `src/lib/plus/codes.ts`, `ios:Sources/kate_ios/Plus/*` | U17, U19, U23; U20 for Stripe codes | none |
| U31 | Year in Review (Plus, no AI, no TMDB) | `ios:Sources/KateCore/YearInReview*`, `ios:Sources/kate_ios/Plus/*` | U23 | Q5 |
| U32 | Landing page with isolated Pixel and Conversions API | `marketing/*`, `src/app/(public)/privacy/page.tsx` | U21 (privacy page edit order) | landing domain (Luke action) |

### Sequencing

U16 first: it changes the limit model everything else reads. Then three tracks: analytics (U19 → U21, U22), lapse (U18) and BYO (U25), with the entitlement track (U17 → U20) following. The paywall (U23) joins the tracks, and its downsell, code, founding and cancel-reason layers (U24, U28, U29, U30) and Year in Review (U31) follow it. U26 is the only path to production for everything. Migration 0055 (U8, `0055_triage.sql`) is merged and applied in production per the 2026-10-16 rollout log, with migrations through 0055 applied on 39213fd; `drizzle/migrations` skips 0052. This plan reserves 0056-0059 (U16, U17, U19, U29). If another migration lands first, a unit takes the next free number at execution, and the preflight, the checklist and AE10 refer to migrations by purpose, not number. Every purchase surface ships dark behind the existing flags; the other units go live through the U15 gate.

**Dependency re-check (this pass).** (1) U18 depended on U17 only to show `source`; its lapse derivation reads `crew_plans` and `crew_usage`, so it now depends on U16 and lets an Apple-only launch skip U17. (2) U23 depended on U17 and U20; the web link needs U20, nothing else does, so U23 ships with `webCheckoutAvailable` false and U20 only adds the row. (3) U24 depended on U20 for everything; the monthly downsell and win-back are client-side and the coupon is the only U20 part. (4) U26 no longer waits on U17, U20, U24 and U25 to enable Plus on Apple only; each of those is merged dark and passes its own checklist section only when its flag turns on. (5) New units hang off U19, U21, U23 and U17 as listed; none has a cycle, and U27 and U32 do not touch the entitlement track.

**Phases.** Phase A is the launch slice below. Phase B (weeks 1-4 of the GTM calendar, each unit dark until its checks pass and its blocking question is confirmed): U27, U17, U20, U28, U30, U24, U29, U31, U25. U32 is not in the launch slice; it is built in parallel with Phase A so the page exists before the Meta test starts on 2026-11-02, and the Meta campaign itself waits for U32 and Luke's Meta actions.

### Launch slice

The minimum before the GTM start on **2026-10-26**. Spend of any kind (Apple Ads at $5/day in week 1, Meta in week 2) starts only after the App Store build is approved and Plus is live in production; nothing in this slice starts the clock by itself.

| Unit | Slice scope | Why it is in |
|---|---|---|
| U16 | all | Caps every hosted crew, protects Luke's crew, keeps BYO free |
| U18 | all | Lapse never deletes; the promise printed on the paywall must be true |
| U19 | all (steps and server counters; the vocabulary already includes the later steps) | The funnel must exist before the first installs |
| U21 | all | The app emits the funnel and the privacy surfaces match what it sends |
| U22 | funnel, paywall moments, activation (KTD21), alerts | Luke reads the numbers from day one, and the GTM go/no-go gates need them |
| U23 | moments, picker, intro offer, states, lapse banner, 3.1.2 disclosures and compliance tests; no web link, no `gate_<id>` | The paid surface, Apple path only |
| U26 | preflight, checklist, spend gate, smoke tests | The only path to production |

Not in the slice, and still safe: U17 and U20 (Apple-only launch; Apple purchases already bind through the existing code), U24 (the monthly downsell and win-back can follow in week 1-2), U25 (BYO stays as it is until it ships, with no limits on self-hosted by U16), U27 to U31, U32 (needed by 2026-11-02, not 2026-10-26). If the slice's iOS build is not in App Review by about 2026-10-22, the GTM clock slides; the GTM plan already says not to start it early. Luke actions 1-4, 6-9, 23 and 24 (including the Small Business Program enrollment) gate this slice.

### System-Wide Impact

- U15 preflight currently asserts "pre-launch crews are grandfathered"; U26 replaces that with the state-aware owner-tier checks described in U16 step 4.
- `docs/error-codes.md` gains `plan_already_active`, and a `plan` hint on `quota_exceeded`.
- The privacy page, `docs/app-store/privacy-labels.md` and `ios:Sources/kate_ios/PrivacyInfo.xcprivacy` change together in U21.
- The website privacy page gains a Pixel and Conversions API paragraph scoped to the landing page (U32), while its "no analytics" line is already replaced in U21; the app's privacy label and manifest stay as U21 leaves them.
- `docs/app-store/review-notes.md` gains the hidden-BYO disclosure (U25), the Founding Crews and offer-code descriptions (U29, U30) and a statement that Year in Review and every paid feature contain no TMDB data (U31).
- `limitsForCrew` callers (`crew.ts`, `invites/config.ts`, `limits/pending.ts`, `limits/usage.ts`, `plus/status`) are all behind one function, so U16 and U18 do not touch them.

### Risks and Dependencies

| Risk | Mitigation |
|---|---|
| Apple rejects the hidden BYO row as an undisclosed feature | KTD20 disclosure in review notes; reveal documented; no payment gate on it. |
| External-link rules differ from assumption (Q1) | Web link is a server-driven capability (`webCheckoutAvailable`) plus a storefront check, so it can be switched off without an app release. |
| Double subscription (Apple and Stripe) | R33, KTD12, alert row, refund runbook in the checklist. |
| Late or out-of-order webhooks | Order by signed date and event `created`; entitlement is time-based (`entitled()`). |
| Analytics seen as tracking | Closed vocabulary, hashed install id, no join keys, label "not linked", off switch. |
| Lapse tightens retroactively and angers people | KTD14: grace, read-only for uploads only, never deletion. |
| Scarcity or price copy judged misleading (3.1.2) | R48 and KTD22: the counter is server truth, no timers, price and renewal terms on every surface, copy tests and a checklist row in U26. |
| Activation metric drifts from what the app nudges | KTD21 computes it from the same tables the app writes; AE17 pins the definition; U27 changes no definition. |
| Pixel leaks into the app or the API origin | KTD25 separate origin, R47 scan test (AE22), consent gate on the landing page. |
| Slice misses App Review timing before 2026-10-26 | Launch slice schedule check; the GTM clock slides rather than starting early. |
| Stripe webhook secret rotation breaks entitlements silently | Digest line shows last Stripe event age; alert when none for 7 days while subs exist. |

### Sources and Research

Code read: `src/lib/plus/*`, `src/lib/limits/*`, `drizzle/migrations/0044_crew_usage.sql`, `0046_plus.sql`, `0050_client_errors.sql`, `src/app/api/appstore/notifications/route.ts`, `src/app/api/v1/plus/status/route.ts`, `src/lib/diagnostics/*`, `src/lib/crew.ts`, `ios:Sources/kate_ios/Plus/*`, `ios:Sources/KateCore/{Plus,Shell,ErrorCatalog,DiagnosticsUploader}.swift`, `ios:Sources/kate_ios/Settings/SettingsView.swift`. Plans read: launch plan U1-U15 (this addendum's parent), `2026-10-12-005` (pricing, IAP flow, lapse policy) and `2026-10-13-004` (Insights and Year in Review aggregation). Growth inputs read for the deepening pass: `~/Downloads/claude/kate-launch/hormozi-playbook.md` (offer, money model, retention, pitfalls; its framework claims come from secondary summaries and were not verified against the books), `gtm-plan.md` (channels, Meta Option B, 30-day calendar from 2026-10-26) and `rollout-log.md` (production on 39213fd, migrations through 0055 applied, triage and alerts working). Code re-verified in this pass: `src/lib/limits/limits.ts` (`maxMembers` 6 and 12), `src/lib/crew.ts` (`getMaxMembers`), `src/lib/db/schema.ts` (`invites`, `crew_members`, `journal_entries` carry `created_at`). Not verified in this planning run: current Apple external-link wording, Stripe API field names; both are re-checked inside the units that depend on them.

---

## Implementation Units

### U16. Owner tier, grandfather invariant, hosted-plans flag

**Goal:** Every hosted crew is under the plan limits; Luke's crew is free by explicit design; `grandfathered` can never be assigned again; self-hosted servers stay uncapped (R30-R32).

**Requirements:** R30, R31, R32; D1, D2; KTD10, KTD11.

**Dependencies:** none.

**Files:**
- `drizzle/migrations/0056_owner_tier.sql` (new)
- `src/lib/db/schema.ts` (enum adds `owner`)
- `src/lib/limits/limits.ts`
- `src/lib/limits/limits.test.ts`
- `src/lib/plus/config.ts` (`isHostedPlans`)
- `src/lib/crew.ts` (lazy default-crew inserts write `owner`)
- `scripts/test/d1-migrations-check.sh`
- `wrangler.jsonc` (hosted var `KATE_HOSTED_PLANS`; not in `wrangler.template.jsonc`)
- `src/app/api/v1/health/route.ts` (adds `hostedPlans`)
- `docs/error-codes.md`, `docs/self-host.md` (one line: no plan limits on your own server)

**Approach:**
1. Migration: `UPDATE crews SET limits_tier = 'owner' WHERE id = 'default'`; `UPDATE crews SET limits_tier = 'free' WHERE limits_tier = 'grandfathered' AND id <> 'default'` (prod has none; the test crew is already `free`); create `BEFORE INSERT` and `BEFORE UPDATE OF limits_tier` triggers that `RAISE(ABORT, 'grandfathered_tier_retired')` when the new value is `grandfathered`. Additive in effect; no table rebuild.
2. `limitsForCrew`: owner returns `{ ...PLUS_LIMITS, crewStorageBytes: UNLIMITED, videosStored: UNLIMITED }`; free as today; a legacy `grandfathered` value on the `default` crew is treated exactly like `owner` until a later release removes it (step 5). When `isHostedPlans()` is off, return an all-UNLIMITED set.
3. Triggers: also `RAISE(ABORT, 'owner_tier_default_only')` when the new `limits_tier` is `owner` and `id <> 'default'`. There is no comp script; comping another crew is a new decision for Luke, not a tool.
4. `scripts/ops/preflight.sh` is U15's deliverable and is not merged, so U16 does not touch it; U26 adds the checks. They are state-aware: while the owner-tier migration is pending it accepts `default` on `grandfathered` and no other grandfathered row; once applied it requires `default` on `owner` (or absent on a fresh DB), zero grandfathered rows, no `owner` row other than `default`, and both triggers present.
5. Deploy order inside the U15 pass: ship code first (`limitsForCrew` treats `owner` and the legacy `default`-on-`grandfathered` row identically, so Luke's crew is never capped between deploy and migration or on a rollback), then apply the migration. The `grandfathered` branch is removed in a later release. After the migration applies, a rollback must target a version that contains this code: older code does not know `owner` and would cap `default` at FREE_LIMITS, so the U26 checklist names the post-U16 version as the rollback target.

**Patterns to follow:** migration 0044 comments; the `limitsForCrew` request-time Plus read.

**Test scenarios:**
- Covers AE10. After the migration `default` is `owner`, the test crew `free`; the update to `grandfathered` aborts and so does an insert.
- A fresh DB that lazily creates `default` gets `owner`.
- Owner crew at 50 GB and 600 videos can still upload a 100 MB video; a 200 MB video is refused (Plus per-file cap).
- Setting `owner` on any crew other than `default` aborts.
- With the migration pending, `limitsForCrew` returns the same limits for `default` on `grandfathered` as on `owner`.
- A free crew is capped at FREE_LIMITS, and with an active Plus subscription at PLUS_LIMITS.
- Covers AE11. With `KATE_HOSTED_PLANS` off a second crew is uncapped and `/plus/status` says `available: false`.
- A seeded legacy `grandfathered` row (inserted before triggers in the test) is rewritten by the migration and not by app code.

**Verification:** `scripts/test/d1-migrations-check.sh` is green; `npm run lint`, `npm run typecheck` and `npm test` are green; a direct SQL assertion on local D1 after applying the migration shows the triggers abort a grandfathered row and a second owner row (U26 turns these into preflight checks).

### U17. Unified entitlement model

**Goal:** Apple and Stripe feed one entitlement answer per crew (R33).

**Requirements:** R33; D3; KTD12.

**Dependencies:** U16.

**Files:**
- `drizzle/migrations/0057_entitlement_source.sql` (new: `subscriptions.source`, `asn_events.source`, `asn_events` index, and `stripe_checkout_state(crew_id primary key, open_session_id, session_expires_at, downsell_coupon_granted_at)`, read by U20 to reuse or expire an open session and by U24 for the once-per-crew coupon)
- `src/lib/db/schema.ts`
- `src/lib/plus/entitlement.ts` (source-agnostic `bindEntitlement`; `bindTransaction` becomes the Apple front end)
- `src/lib/plus/notifications.ts` (writes `source = 'apple'`)
- `src/lib/plus/plus.test.ts`
- `scripts/expected-tables.txt`

**Approach:**
1. Extract the bind rules (owner only, one purchase backs one crew, stale-write protection, never clear a revocation) into `bindEntitlement({ source, externalId, state, lastSignedDate, userId, crewId })`; Apple verification and the appAccountToken check stay in the Apple front end.
2. Add the "second source while entitled" refusal and the double-active alert (reuse `src/lib/ops/alerts.ts`).
3. `crewPlanState` returns `source` so status and the digest can show it.
4. Existing rows backfill `source = 'apple'` by column default.
5. The app's foreground status refresh calls `/plus/verify` to re-pull the current Apple expiry, a second source of truth if a notification is missed.

**Test scenarios:**
- Existing Apple tests pass unchanged.
- Covers AE12 (model level). A crew with an active Apple row refuses a Stripe bind with 409 `plan_already_active`; an expired Apple row allows it and the crew's `crew_plans` row moves to the Stripe subscription.
- Two simultaneous binds from different sources leave one backing row and one alert.
- A Stripe-namespaced id cannot collide with an Apple id (`stripe:` prefix test).
- A stale Stripe state never overwrites a newer one.

**Verification:** migration check, unit tests and typecheck green; `plus/status` for an Apple-backed crew is byte-identical to before.

### U18. Lapse and read-only downgrade

**Goal:** When Plus lapses the crew keeps everything and can still read, export and delete; only new uploads over FREE_LIMITS are refused after a 30 day grace (R35).

**Requirements:** R35; D4; KTD14.

**Dependencies:** U16 (shows `source` in the status JSON once U17 lands).

**Files:**
- `src/lib/limits/limits.ts` (`lapseState`)
- `src/lib/limits/usage.ts`, `src/lib/limits/pending.ts` (use lapse-aware limits)
- `src/lib/limits/refusal.ts` (`plan` hint)
- `src/app/api/v1/plus/status/route.ts` (`lapsedAt`, `graceEndsAt`, `overFree`)
- `src/lib/limits/limits.test.ts`
- `docs/error-codes.md`, `docs/delete-contract.md` (note: lapse never deletes)

**Approach:**
1. `lapseState(db, crewId, now)` derives `lapsedAt` from the last entitled period and `overFree` from `crew_usage` against FREE_LIMITS.
2. During grace, uploads follow PLUS_LIMITS (nothing changes for the person); after grace, free limits apply and over-cap crews get 402 on new uploads only.
3. Export, delete, restore and reads read no limit (as today); a test asserts it. Members are never removed: `getMaxMembers` falls back to the crew's stored cap after lapse, so a lapsed crew above it keeps every member and refuses only new joins with `crew_full`.
4. Status exposes the dates so the app can show "your Plus ended, X days left to free space or resubscribe".

**Test scenarios:**
- Covers AE13. A crew over cap lapsed 10 days ago still uploads; at day 31 uploads refuse with 402, while list, export and delete succeed.
- A resubscribe on day 40 restores PLUS_LIMITS with no repair step.
- A crew under FREE_LIMITS shows no lapse banner fields.
- No code path in the diff issues a DELETE on media for lapse (grep test on the module).
- Owner tier never reports lapse.
- A lapsed 10-member crew past grace keeps all 10 members, refuses a new invite acceptance with `crew_full`, and removes nobody.
- A refund on day 5 of a yearly plan puts the crew on FREE_LIMITS immediately with no grace.

**Verification:** unit tests green; manual local run shows the status JSON for each state.

### U19. Growth analytics backend

**Goal:** Install-scoped anonymous events stored in D1 on the U6 pattern (R38, R41).

**Requirements:** R38, R41; D5, D6; KTD15, KTD16.

**Dependencies:** U16 (hosted flag); pattern from U6. U19 owns the whole event vocabulary (including `cancel_reason` and `code_redeemed`) so later units add no migration or scrubber change.

**Files:**
- `drizzle/migrations/0058_growth_events.sql` (new: `growth_daily`, `install_steps`)
- `src/lib/growth/store.ts`, `src/lib/growth/scrub.ts`, `src/lib/growth/store.test.ts` (new)
- `src/app/api/v1/growth/events/route.ts` (new)
- `src/lib/api/guard.ts` (route joins the exempt list, as diagnostics)
- `src/lib/ops/usage-guard.ts` (growth row volume metric)
- `worker.ts` (90-day purge of `install_steps`)
- `scripts/expected-tables.txt`, `docs/error-codes.md`

**Approach:**
1. `POST /api/v1/growth/events` takes `{ installId, build, events: [{ step, variant?, day? }] }`, up to 20 events and 4 KB. Signed-in or signed-out both accepted; the handler never reads the session.
2. The scrubber enforces the closed vocabulary (KTD16), build pattern from U6, and ignores every other field. Server-only steps (`renewal`, `cancel`, `code_redeemed`) are rejected from the client. A client `purchase_completed` is stored in `install_steps` only; the server bump alone writes `growth_daily` (combined source and plan variant).
3. `install_hash` from a salted SHA-256; first occurrence of (hash, step) inserts a row and bumps the counter; repeats bump only `growth_daily` for repeatable steps (`paywall_viewed`, `purchase_started`) and are dropped for once-per-install steps.
4. Budgets: per-install per-day cap, per-IP per-hour cap, a day budget of new `install_steps` rows; over budget still bumps `growth_daily`.
5. Server-side counters `renewal`, `cancel` and refund are bumped through `bumpGrowth(db, step, variant)` with no install. U19 wires it into the Apple writer in `src/lib/plus/notifications.ts`; U20 calls it from the Stripe webhook. `purchase_completed` is also bumped server-side (combined source and plan variant, `growth_daily` only) when a first bind succeeds, so purchases by source never depend on a client report.
6. Respect `growth_enabled` in `system_flags` so Luke can stop ingestion.

**Patterns to follow:** `recordReport`, `withinRateLimit`, `scrubReport`, the U6 route and its test layout.

**Test scenarios:**
- Covers AE15. A payload with `crewId`, `title`, `userId` or an unknown variant stores none of it; an unknown step is rejected as a whole.
- A client post of `renewal` or `code_redeemed` is rejected as a whole; `cancel_reason` with a variant outside the four reasons is rejected.
- The same install posting `first_entry` 10 times yields one `install_steps` row and `growth_daily` count 1.
- The raw install id appears in no column (query test).
- A flood hits the per-IP cap with 429 and cannot consume the diagnostics budget.
- Past the new-row budget the daily counter still increments.
- `renewal` from the entitlement writer lands in `growth_daily` with no `install_steps` row.
- Rows older than 90 days are purged.

**Verification:** posting a sample batch locally shows hashed rows only; migration check green.

### U20. Stripe web checkout and webhooks

**Goal:** A US owner can buy Plus on the web with Apple Pay or card, and the result reconciles through U17 (R33, R34).

**Requirements:** R33, R34; D3, D6; KTD12, KTD13.

**Dependencies:** U17, U19 (`bumpGrowth`).

**Files:**
- `src/lib/plus/stripe/client.ts`, `signature.ts`, `webhook.ts`, `mapping.ts`, `stripe.test.ts` (new)
- `src/app/api/v1/plus/checkout/route.ts` (new: create Checkout Session; owner only)
- `src/app/api/v1/plus/portal/route.ts` (new: Billing Portal session)
- `src/app/api/stripe/webhook/route.ts` (new; not bearer-authenticated, signature is the credential)
- `src/lib/plus/config.ts` (`stripePriceIds`, `webCheckoutAvailable`)
- `src/app/(public)/plus/return/page.tsx` (new: landing with five states: success with an open-app link and a fallback line, cancelled with no charge, processing ("this can take a minute; Kate updates when you return"), error, and `portal` (the Billing Portal `return_url` target that U24 extends with the coupon offer and U28 with the cancel-reason buttons); the deep link is a fixed `kate://` target with nothing passed through)
- `src/lib/api/guard.ts` (webhook exempt from the kill switch, like the Apple route)
- `docs/error-codes.md`, `docs/release-checklist.md`

**Approach:**
1. All three routes return the same "plus disabled" no-op as the Apple route while `isPlusEnabled()` is false, with no database access on the webhook.
2. Checkout creation requires a session user who is the crew owner, an entitled-free crew (`plan_already_active` otherwise), a price id from config (`monthly` or `yearly`), optional opaque `couponId` (validated against `offers.ts` once U24 lands; ignored and logged when unknown; the coupon parameter stays unused until Q3 is confirmed), and returns `{ url }`. When no coupon is attached the session sets `allow_promotion_codes` so a Stripe promotion code (U30) can be typed on the hosted page; Stripe does not accept both, so a coupon-bearing session omits it. Success and cancel URLs are built from a configured origin constant, never from request input or the Host header, and point to the return page; an existing open session for the crew is reused or expired rather than creating a second.
3. Webhook reads the raw body under a 256 KB cap, verifies the signature, checks livemode and price allowlist, dedupes and maps per KTD13, calls `bindEntitlement` with source `stripe` (crew from `client_reference_id`, user from metadata, so no appAccountToken analogue is needed; the handler rejects any session whose crew and user are not an owner membership in D1 or that the checkout route did not create, marked by a server-set metadata flag), bumps `renewal` or `cancel` growth counters.
3a. If `bindEntitlement` refuses a paid session with `plan_already_active` (two open sessions, or an Apple purchase landed first), the handler cancels the new Stripe subscription with a refund through the API and writes an alert row with the outcome; it never leaves a paid, unentitled customer for manual repair. A refused Apple bind returns a distinct response the app shows as "you already subscribe on the web" with refund guidance.
4. The portal route resolves the Stripe customer from the caller's own crew `crew_plans` row, returns 403 unless the session user holds the owner membership of that crew (no Stripe call is made otherwise), and returns a Billing Portal URL with `return_url` set to the `portal` state of the return page; Apple-backed crews get the App Store subscriptions link instead.
4a. `client.ts` pins a `Stripe-Version` header and reads period fields as that version defines them (period end may live on the subscription items); `charge.refunded` and `charge.dispute.closed` payloads reference a charge, so the handler resolves charge to invoice to subscription through the injected fetch and logs a no-op when no Kate subscription is found.
5. Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` (Luke creates; names listed in U26). Test mode and live mode are separated by key, with a startup log of the mode.

**Test scenarios:**
- A valid signed `checkout.session.completed` binds Plus to the named crew; an invalid or expired-timestamp signature returns 400 and writes nothing.
- A replayed event id is acknowledged once and applied once; a bind that throws leaves the event retryable and the retry applies.
- An event with the wrong `livemode`, an unlisted price id or a crew/user pair that is not an owner membership writes nothing; a body over 256 KB is rejected before HMAC.
- A paid session refused as `plan_already_active` triggers a cancel-with-refund call and an alert row.
- A partial refund does not revoke; a full refund and a lost dispute do, each resolved from the charge to its subscription by fixture, with a no-op when none is found.
- `past_due` grace is measured from the failed invoice, with a pinned API version fixture.
- `customer.subscription.updated` to `past_due` yields grace; to `canceled` yields expired at period end.
- Out-of-order or same-second events resolve to the state the Stripe API returns at handling time.
- A refund or lost dispute revokes.
- A non-owner gets 403 on checkout and on the portal route (no Stripe call); a crew with active Apple Plus gets 409.
- With `KATE_PLUS_ENABLED` off every route is inert and the webhook touches no table.
- Stripe API calls go through an injected fetch with fixtures, so tests never hit the network.

**Verification:** unit tests green on the self-hosted runner three times; one manual Stripe test-mode run by Luke is recorded in the checklist.

### U21. iOS growth events and privacy

**Goal:** The app emits the funnel steps anonymously and the privacy surfaces say so (R38).

**Requirements:** R38, R41; D5; KTD15, KTD16.

**Dependencies:** U19.

**Files:**
- `ios:Sources/KateCore/GrowthEvents.swift`, `ios:Sources/KateCore/GrowthUploader.swift` (new; reuse the Keychain install id and backoff of `DiagnosticsUploader`)
- `ios:Sources/kate_ios/AuthStore.swift`, `ios:Sources/kate_ios/Auth/*` (signup started, account created)
- `ios:Sources/kate_ios/CrewSection.swift`, `ios:Sources/kate_ios/Invites/*`, journal create path (crew created, first entry, invite sent, invite accepted)
- `ios:Sources/kate_ios/Settings/*` (toggle "Share anonymous usage")
- `ios:Sources/kate_ios/PrivacyInfo.xcprivacy`
- `ios:Tests/KateCoreTests/GrowthEventsTests.swift` (new)
- `docs/app-store/privacy-labels.md`, `src/app/(public)/privacy/page.tsx` (kate repo)

**Approach:**
1. `GrowthEvents.record(step, variant)` appends to a small on-disk queue (cap 100), de-dupes once-per-install steps locally, and uploads batched on launch and foreground with Retry-After handling; failures never enter ErrorLog.
2. The event enum is the same closed list as the server; there is no API that takes a free-form string.
3. `install` fires on first launch; `invite_accepted` fires on the accepting install, after join.
4. The toggle lives under Settings > Privacy with the helper line "Anonymous counts only. No account, crew or content attached." and a privacy page link, reachable within two taps of Settings. Off clears the queue and stops recording; default on, because the data is anonymous.
5. Privacy label: add "Usage Data > Product Interaction", not linked to the user, not used for tracking, purpose Analytics. Update the manifest and the privacy page ("anonymous usage counts, no account or content attached; turn off in Settings"), replacing the line that says there is no analytics.

**Test scenarios:**
- Once-per-install steps are not queued twice.
- The queue never exceeds 100 and drops oldest first.
- A 429 with Retry-After defers by at least that long (injected clock).
- Toggle off records nothing and uploads nothing.
- The manifest test lists Product Interaction as not linked and not tracking.
- A compile-level test asserts the event type has no payload except step and variant.

**Verification:** a debug build's first run shows `install` and `signup_started` rows in local D1 on the next foreground.

### U22. Triage funnel report and digest

**Goal:** Luke sees the funnel, the activation rate, the paywall breakdown, cancel reasons and code redemptions on the U8 page and in the daily digest (R39, R42).

**Requirements:** R39, R42; D5; KTD21.

**Dependencies:** U19, U8 (merged).

**Files:**
- `src/lib/growth/report.ts`, `src/lib/growth/report.test.ts` (new)
- `src/app/(admin)/triage/page.tsx`
- `src/lib/diagnostics/digest.ts`, `src/lib/diagnostics/digest.test.ts`
- `worker.ts` (none beyond the existing digest cron)

**Approach:**
1. `funnelReport(db, days)` computes, per step in order, installs that reached it (from `install_steps`), conversion from the previous step and from install, for yesterday and the trailing 7 days; plus paywall views by moment, purchases by source and plan, renewals and cancels from `growth_daily`, and active Plus crews by source with an estimated monthly revenue from price constants (labelled an estimate).
2. The triage page renders a Funnel section with escaped text and no inline script, under the existing cookie gate.
3. The digest adds a plain-text funnel block; an empty day says so in one line. No model summarizes it.
3a. Activation (KTD21, R42): `activationReport(db, days)` counts crews created per day, those whose second member joined within 48 hours, and those with a later journal entry, and prints counts and the rate over matured cohorts only (crews created at least 3 UTC days before the report date, so the 48-hour window and the entry check have closed; the trailing 7-day window ends 3 days before the report date), with crews still inside the window shown as a separate "still open" count, beside the funnel; join time is `crew_members.created_at`. The same block lists `cancel_reason` counts by reason (with the count of cancels, so the share of cancels that gave a reason is visible), `code_redeemed` by campaign key, and Founding Crews claimed of cap once U29 exists. All of it is counts only.
4. Alerts: a paywall-to-purchase rate drop of more than half week over week with at least 50 views, no Stripe event for 7 days while Stripe-backed crews exist, and no accepted App Store notification for 7 days while Apple-backed crews exist. When the day's new-row budget was reached the funnel prints "budget hit, per-install rates unreliable" and the rate-drop alert is suppressed. Purchases and revenue come from server-side counters; client-reported steps are labelled unverified.

**Test scenarios:**
- Seeded installs reaching different steps give exact counts and rates.
- A step reached without the previous one (client skipped) still counts, and the report never shows a rate above 100%.
- The digest over seeded data contains the funnel block, the moment breakdown and the alert.
- A day with the row budget hit shows the unreliable flag and no rate-drop alert.
- The page without the cookie is 404; a variant string containing markup renders escaped.
- Covers AE17. Seeded crews A, B and C, all created 3 or more days before the report date, give activation 1 of 3, a crew created yesterday appears only under "still open", and the report query returns no crew id.
- A crew whose second member joined at hour 47 counts and at hour 49 does not; an entry created before the join does not complete activation.
- Cancel reasons and code campaigns render as counts; a campaign key outside the table is not rendered.
- No data yields "no funnel data yesterday".

**Verification:** the web screenshot run renders the Funnel section; a manual cron trigger delivers the digest.

### U23. Paywall v2: moments, picker, intro, web link

**Goal:** People hit a clear paywall at limits and gates, with yearly preselected, the intro offer and the US web option where allowed (R34, R36, R37, R41).

**Requirements:** R34, R36, R37, R41, R48; D3, D4; KTD17, KTD19.

**Dependencies:** U18, U21; U20 for the web link only (U23 ships with `webCheckoutAvailable` false until U20 merges). Blocked on Q5 only for `gate_<id>` variants.

**Files:**
- `ios:Sources/KateCore/Paywall.swift` (`PaywallPlanner`, `PaywallMoment`, copy), `ios:Sources/KateCore/Plus.swift`
- `ios:Sources/kate_ios/Plus/PlusStore.swift` (products, purchase, `Product.SubscriptionInfo.isEligibleForIntroOffer`, `Storefront.current`)
- `ios:Sources/kate_ios/Plus/PaywallView.swift` (new; `PlusView` hosts it), `ios:Sources/kate_ios/Plus/PlusView.swift`
- `ios:Sources/kate_ios/Journal/*`, `ios:Sources/kate_ios/Invites/*` (present the paywall on limit refusals)
- `ios:Sources/KateCore/ErrorCatalog.swift` (limit refusals route to a moment)
- `ios:Tests/KateCoreTests/PaywallPlannerTests.swift` (new), `ios:UITests/PaywallUITests.swift` (new)
- `src/lib/plus/features.ts` (new, allowlist, KTD19), `src/app/api/v1/plus/status/route.ts` (adds `webCheckoutAvailable`), `docs/app-store/review-notes.md`

**Approach:**
1. Moments: a refusal with `limit` of storage, videos, file_size, video_length, or a members refusal, plus feature gates from `features.ts`. `limit_members` fires owner-side: when the owner opens or creates an invite and the member (or pending invite) count reaches `limits.maxMembers` from `/plus/status`; the invitee sees the existing `crew_full` copy with no paywall. Each moment presents the paywall sheet with a one-line reason ("Your crew's storage is full") above the picker. Free-tier actions that do not need Plus never show it.
2. Only the owner of a free hosted crew sees purchase; members see "Ask <owner>" (existing `memberNote`); owner tier and self-hosted show nothing.
3. Picker: yearly default with trial line when eligible and the monthly price; terms, privacy, Restore always visible (guideline 3.1.2). `paywall_viewed` and `purchase_started` fire with the moment variant; the client's `purchase_completed` carries only the source variant and feeds the per-install funnel (KTD16); plan and source breakdowns come from the server count.
4. Web option: visible only when server `webCheckoutAvailable`, `Storefront.current?.countryCode == "USA"`, and the build is compiled with Plus; tapping opens the checkout URL from U20 in the system browser (`SFSafariViewController` is not used so the cookie jar is not shared). Placement and wording follow the re-read of Apple's rules from Q1; the checklist records the quote.
5. After a web purchase the app refreshes status on return and on foreground; Apple Pay on the web happens in Stripe's hosted page.
6. Plus feature copy never mentions movies, recommendations or streaming (R41).
7. Disclosure (guideline 3.1.2): every plan row shows title, period and the localized StoreKit price; the trial line states the trial length and the price that follows; every paywall variant carries an auto-renew and cancel-anytime line plus Terms, Privacy and Restore at readable size. U24's downsell states the discounted price, its duration and the regular price after.
8. States, with strings in KateCore copy so they are unit-testable: products loading, product fetch failure (retry, Restore still shown), user-cancelled (silent), pending or Ask to Buy, purchase failed, Restore finding nothing, `plan_already_active` on web (names the current source, links Manage), web purchase awaiting reconciliation ("Confirming your purchase", status poll on foreground, timeout copy).
9. Role by state matrix, owned by `PaywallPlanner`: owner free, owner Plus active, owner in lapse grace, owner over cap after grace, member, owner tier, self-hosted, by surface (Settings Plus row, limit sheet, feature gate, lapse banner). Members get a non-purchase sheet naming the owner with Done; owner tier and self-hosted hide the Plus row.
10. Lapse banner on the Plus screen and the crew screen from `plus/status`: grace (owner: "Plus ended, N days left to free space or resubscribe" with Resubscribe; member: "Ask <owner>"), after grace over cap (uploads blocked; library readable, exportable and deletable), under cap shows nothing.
11. After a web purchase, once the post-return status refresh shows Plus active, the app records `purchase_completed` with the `stripe` variant (the app-side step that keeps web buyers in the per-install funnel; the purchase count itself is the server's).
12. Pitfall guards (R48), enforced as KateCore tests and a U26 checklist row: no countdown or timer string anywhere in paywall copy; no tier or option that exists only to make another look better (decoy), and no more than the two real plans plus the one downsell or win-back shown; no trial that charges a penalty or that auto-converts without the price and renewal line next to the button; no price shown that is not the localized StoreKit price; no urgency or scarcity wording unless it comes from U29's server counter; no wording that promises a refund (Apple decides in-app refunds; the Stripe refund policy text is Luke's); Terms, Privacy and Restore on every variant.
13. Member help (answers part of Q6): the member sheet offers one tap that opens the share sheet with a pre-written "Our Kate crew is out of room, can you upgrade?" message; it names no price and sends nothing automatically.
14. Accessibility: sheets scroll and reflow at the largest Dynamic Type; plan rows are single accessible elements with selected trait and a combined label; close controls have labels and 44 pt targets; verifier and offer states are conveyed in text, not color alone.

**Test scenarios:**
- Planner: owner of free crew with `limit: storage` yields moment `limit_storage`, yearly default, intro line only when eligible.
- Planner: member, owner tier, `plus` active and unavailable entitlement each yield no purchase UI.
- Planner: non-US storefront or `webCheckoutAvailable == false` hides the web option; US shows it.
- Covers AE14 in a UI test with the StoreKit configuration fixture on the macOS build host.
- A refused video upload in the outbox surfaces one paywall, not one per retry.
- Covers R48. A KateCore copy test fails on any of `countdown`, `ends in`, `only N left`, `hours left` outside the U29 counter path, on a paywall variant missing price, period, renewal line, Terms, Privacy or Restore, and on a refund promise.
- The member sheet's share message contains no price and is not sent without the share-sheet confirmation.
- Copy test: no string in the paywall bundle contains "movie", "film", "TMDB" or "recommend".
- Planner tests cover every row of the role matrix, every lapse-banner state, and the presence of the 3.1.2 elements on picker, downsell and win-back.

**Verification:** `KATE_CORE_ONLY=1 swift test` green on Linux; sandbox purchase of the yearly product on a TestFlight build, recorded in the checklist by Luke.

### U24. Downsell and win-back

**Goal:** A person who dismisses the paywall sees the monthly plan once, a lapsed Apple owner sees StoreKit's win-back offer, and a Stripe buyer can get a 3-month coupon once per crew (R36). No Apple offer is signed by Kate.

**Requirements:** R36, R48; D4; KTD18.

**Dependencies:** U23; U20 for the Stripe coupon. **Blocked on Q3** (proposed — awaiting Luke's confirmation): no code starts until Luke confirms the monthly-downsell, win-back and Stripe 3-month coupon shape.

**Files:**
- `src/lib/plus/offers.ts` (new: one table of win-back and coupon ids, eligibility, exclusion rules, copy keys; also adds the coupon validation that U20's checkout parameter defers to)
- `src/lib/plus/offers.test.ts` (new)
- `ios:Sources/KateCore/Paywall.swift` (`Downsell` decision), `ios:Tests/KateCoreTests/PaywallPlannerTests.swift`
- `ios:Sources/kate_ios/Plus/PaywallView.swift`, `ios:Sources/kate_ios/Plus/PlusStore.swift`
- `ios:Sources/kate_ios/Plus/WinBackView.swift` (new)

**Approach:**
1. On dismiss of a paywall opened from a moment, show one downsell sheet per 14 days per install: the monthly plan, framed as a shorter commitment and not a price cut ("Not ready for a year? Try monthly"). Never shown twice in one session, never to members, owner tier or active Plus. Shown only if the dismissed picker did not already present monthly as an equal choice.
2. Win-back: for an expired Apple subscription, StoreKit's win-back offer is shown on the Plus screen and the lapse banner using `Product.SubscriptionInfo.RenewalInfo` eligibility, with the offer created in App Store Connect (Luke action; suggested shape 3 months at about half price, pay as you go, then the normal price, a hypothesis to measure). If StoreKit exposes no eligible win-back offer, nothing is shown. Win-back APIs are iOS 18: gate with `#available(iOS 18.0, *)`, show nothing on iOS 17, and keep eligibility logic in the KateCore planner. The sheet reads "your memories are all still here" and states the discounted price, its duration and the regular price after (3.1.2).
3. Stripe path: the downsell passes the coupon id from `offers.ts` to checkout creation (U20), a `repeating` 3-month coupon created with a per-customer redemption limit; cancel of a Stripe subscription lands on the `portal` state of the return page (U20), which offers the same coupon once.
4. Eligibility is server-side: a crew gets the Stripe downsell coupon once (`stripe_checkout_state.downsell_coupon_granted_at`, U17), a client-sent coupon id the server did not grant is ignored, and `offers.ts` states the exclusion rules among the intro trial, win-back and offer codes (U30). The 14-day cadence is a UI courtesy, not the control.
5. Events: `paywall_viewed` with variant `downsell` or `winback`; `purchase_started` carries the moment; the server's `purchase_completed` count carries plan and source. After 100 paywall views, U22 reports paywall-to-purchase with and without the downsell; a downsell that adds under about one percentage point is removed, since each extra sheet is friction and a disclosure burden.

**Test scenarios:**
- Downsell shows once after a dismiss, not again within 14 days (injected clock), and never in the same session.
- Planner: member, owner tier and active Plus see no downsell; a picker that already showed monthly equally does not trigger it.
- Win-back with no eligible offer renders nothing; on iOS 17 nothing renders.
- Win-back and downsell copy carry price, duration, regular price after, Terms, Privacy and Restore (R48 test from U23 extended).
- Checkout with a coupon id attaches exactly that coupon; an unknown coupon id is ignored and logged; a second request for the same crew is refused.
- The `portal` return state offers the coupon once.

**Verification:** a sandbox win-back purchase on iOS 18 and a Stripe test-mode coupon checkout, both recorded by Luke in the checklist.

### U25. BYO server: hide and guided setup

**Goal:** Own-server connection keeps working, is hidden from ordinary users, is free, and has a guided deploy, connect and verify path (R32, R40).

**Requirements:** R32, R40; D2; KTD11, KTD20.

**Dependencies:** U16.

**Files:**
- `ios:Sources/KateCore/Shell.swift` (`SettingsFlags.byoServerRevealed`, `advancedRows`), `ios:Tests/KateCoreTests/*Shell*`
- `ios:Sources/kate_ios/Settings/SettingsView.swift`, `ios:Sources/kate_ios/Settings/ByoServerGuideView.swift` (new)
- `ios:Sources/KateCore/ServerVerifier.swift` (new: checks scheme, `/api/v1/health` with `schemaReady`, minimum server version, setup state), `ios:Tests/KateCoreTests/ServerVerifierTests.swift` (new)
- `ios:Sources/kate_ios/Auth/*` (hide the "Using your own Kate?" link until revealed; handle `kate://connect?server=`)
- `ios:Sources/kate_ios/Info.plist` (URL scheme if absent)
- `docs/self-host.md`, `src/app/(public)/self-host/page.tsx` (guided three-step page with the deep link), `docs/app-store/review-notes.md`

**Approach:**
1. Default `advancedRows` omits Switch server. Reveal: five taps on the version row, or the `kate://connect` link. The flag persists in UserDefaults.
2. Guided flow screens: (1) Deploy: explains the Deploy to Cloudflare button and shows the docs link; (2) Connect: address field with pasted-URL cleanup using the existing `ServerAddress`; (3) Verify: runs `ServerVerifier` and shows each check (reachable, HTTPS, migrated, version compatible, setup complete) with a plain fix hint per failure; Switch only when all pass. The existing sign-out behavior and subtitle stay.
3. A server that is not hosted shows no Plus UI (`/plus/status` unavailable) and no limits (U16), asserted by a test against the verifier's capability read.
4. Docs page: deploy button, secrets table, `/setup` steps, "connect from the app" with the deep link, troubleshooting table keyed to the verifier's failure messages, and the statement that it costs nothing to Kate users.
5. Review notes disclose the hidden entry and how to reveal it.
6. `kate://connect` only prefills the address field. It never runs the verifier or switches by itself, rejects userinfo, IP literals and non-HTTPS, and the Switch step always shows a confirmation naming the full host and stating that sign-in and all content will go to that server and that the current session ends. A verifier all-green means "reachable and compatible", not "trusted", and the copy says so. The app never sends the current server's session or token to the new server.
7. Flow states: each check shows running, pass or fail with Retry; the typed address survives back navigation; a connected-to-custom-server view offers "Switch back to Kate"; the version-row reveal has an accessible alternative (a VoiceOver custom action).

**Test scenarios:**
- Default Advanced rows contain no Switch server; with the reveal flag they do.
- Five taps reveal; four do not.
- A `kate://connect?server=https://x.example` link opens the guide at the Connect step with the address filled; a non-HTTPS or malformed URL is refused with copy.
- Verifier fixture matrix: unreachable, plain HTTP, `schemaReady: false`, old version, setup open, all good; each maps to its message and only all-good enables Switch.
- Covers AE16 end to end in a UI test with a local stub server.

**Verification:** Linux `swift test` for the verifier and shell tests; UI test on the macOS build host; docs page renders in the web screenshot run.

### U26. Monetization release gate and Luke checklist

**Goal:** Monetization goes live only through the U15 gate with both flags on together and every Luke action for the features being switched on done (R30-R48, D6). This is the only path to production for every unit in this plan.

**Requirements:** D6, R48; KTD8.

**Dependencies:** the launch slice (U16, U18, U19, U21, U22, U23) and U15. Every other unit is merged dark or deferred; its own checklist section must pass before its flag turns on, and it never blocks the Apple-only Plus switch-on.

**Files:**
- `docs/release-checklist.md` (adds a Monetization section)
- `docs/launch-checklist.md`
- `scripts/ops/preflight.sh` (new checks, below)
- `ios:scripts/testflight.sh` (existing `KATE_PLUS_RELEASE_OK` guard also requires the checklist entry id)
- `docs/app-store/review-notes.md`, `docs/app-store/privacy-labels.md`

**Approach:**
1. Preflight additions (U26 depends on U15, which owns the script; they are state-aware as described in U16 step 4): `default` is `owner` and no crew is `grandfathered` and no non-`default` owner; both triggers present; `KATE_HOSTED_PLANS` present in the hosted config; the monetization migrations (reserved 0056-0059; resolved by purpose, not number) pending or applied as expected for the units being enabled; secret names present (`STRIPE_*`; `APPSTORE_IAP_*` only if Luke later picks promotional offers) as warnings before launch and as stops when `KATE_PLUS_ENABLED` is about to be set; `KATE_PLUS_ENABLED` still absent until the gate says otherwise.
2. The monetization section lists, in order: R13 precondition recorded (Wikidata source or TMDB written answer), sandbox purchase, Stripe test purchase, lapse drill in staging, privacy label published, review notes updated, digest shows a funnel, then and only then both flags on together.
3. The monetization migrations (reserved 0056-0059) are applied through the U15 pass procedure (preflight, no other session deploying, apply, deploy, smoke test, record). This plan applies nothing itself.
4. Smoke tests on production: `/api/v1/health` reports `hostedPlans: true`; Luke's crew still uncapped and shows no paywall; a new account is capped at free limits; with Plus on in staging a purchase moves a crew to PLUS_LIMITS.
5. Spend gate: a checklist section Luke signs before any ad or Apple Ads budget is activated. It requires the App Store build approved and live (recorded with the date), production `/api/v1/plus/status` reporting `available: true` for a test crew, a real sandbox or TestFlight purchase recorded, the digest showing a funnel block and an activation line, and Luke's budget approval recorded. If any row is false, spend stays at zero.
6. Pitfall checklist (R48), each row a yes or no with the evidence: the paywall copy tests green; yearly and monthly are the only plans shown plus one real downsell or win-back; trial lines state the price that follows; no countdown or resetting timer; the Founding Crews count equals the server count; no refund promise in the app; App Review notes name the offers and codes that ship, and the hidden BYO entry once U25 has shipped; the price-lock setting for Apple price rises is confirmed (U29).
7. Per-feature sections (only when that feature is switched on): Stripe test purchase and coupon (U20, U24), Founding Crews (U29), offer codes redeemed in sandbox (U30), Year in Review PDF opened (U31), marketing scan test and privacy page disclosure live (U32).
8. Writes the checklist to the repo and to `~/Downloads/claude/kate-launch/monetization.md`.

**Test expectation:** preflight is run against local D1 with a deliberately grandfathered row, a missing trigger and a set `KATE_PLUS_ENABLED`; each exits non-zero naming its check.

**Verification:** the checklist exists, the dry-run guards trip, and no production change was made outside U15.

### U27. First-value activation nudges

**Goal:** More crews reach the first shared entry, measured by the activation metric in U22 (R42).

**Requirements:** R42; D5; KTD21.

**Dependencies:** U21, U22. Never behind the paywall: free-tier and self-hosted people get it.

**Files:**
- `ios:Sources/KateCore/Nudges.swift` (new: `NudgePlanner`), `ios:Tests/KateCoreTests/NudgePlannerTests.swift` (new)
- `ios:Sources/kate_ios/Nudges/*` (new: local notification scheduling, the share-sheet invite prompt, the first-entry template sheet)
- `ios:Sources/kate_ios/Settings/*` (a "Reminders" toggle beside the usage toggle)
- `src/lib/growth/report.ts` (activation query per KTD21, if U22 has not landed it; no schema change)

**Approach:**
1. Moments, planned by `NudgePlanner` from plain inputs (crew age, invite state, member count, entry count, last nudge time, toggle): after creating a crew with no invite, one-tap invite via the share sheet at creation and a local reminder at 24 hours; after an invite is sent but not accepted, a reminder at 36 hours ("Your invite to <name> is still open") inside the 48-hour window; after a partner joins with no shared entry, a first-entry template sheet ("Today I...", "First walk") and a reminder the next day.
2. Local notifications only, requested in context after the first invite action, never at launch. A person who declines or turns Reminders off gets none; at most three nudges per crew in total, never between 21:00 and 09:00 local, no guilt copy, no streaks.
3. No new event and no new server field: the metric is computed server-side (KTD21) from `crew_members.created_at` and `journal_entries.created_at`.
4. The template sheet pre-fills text the person can edit or discard; it creates nothing until they save.

**Test scenarios:**
- Planner: a crew with no invite at 24 hours schedules one reminder; with the toggle off or permission denied it schedules none.
- An invite accepted at hour 30 cancels the pending 36-hour reminder.
- A fourth nudge for the same crew is never planned; none lands between 21:00 and 09:00.
- A partner join with zero entries plans the template sheet once.
- The nudge copy bundle contains no price, no streak or loss wording and no TMDB or movie term.

**Verification:** `KATE_CORE_ONLY=1 swift test`; on a debug build a new crew shows the invite prompt and the 24-hour reminder in the pending notification list.

### U28. Cancel-reason prompt

**Goal:** Learn why owners leave, in a closed vocabulary, without getting in their way (R43).

**Requirements:** R43; D4, D5; KTD16.

**Dependencies:** U19, U21, U23 (lapse banner); U20 for the Stripe path.

**Files:**
- `ios:Sources/KateCore/Paywall.swift` (`CancelReason`, planner rule), `ios:Tests/KateCoreTests/PaywallPlannerTests.swift`
- `ios:Sources/kate_ios/Plus/PlusView.swift` (the one-tap row in the lapse banner)
- `src/app/(public)/plus/return/page.tsx` (cancel return state shows the same four buttons, posting through a first-party form with no free text)
- `src/lib/growth/report.ts` (counts, already planned in U22)

**Approach:**
1. Apple cancellation happens outside the app, so the prompt appears on the first Plus screen or banner view after the app sees the subscription expire or turn off auto-renew. Stripe cancels see it on the `portal` state of the return page (U20).
2. Four buttons and a "Skip" with the same weight: "Too expensive" (`reason_price`), "Not using it" (`reason_not_using`), "Missing something" (`reason_missing`), "Something else" (`reason_other`). One tap sends `cancel_reason` with that variant; Skip sends nothing. It shows once per lapse and never blocks, delays or changes access, export, delete or the win-back sheet.
3. No free text, no email, no follow-up. The count is anonymous like every U19 event. Every ~20 cancels Luke reads the top two reasons in the digest and decides what to fix; the app does nothing automatic.

**Test scenarios:**
- Covers AE18. One tap posts one `cancel_reason` and the prompt does not return for that lapse; a resubscribe and a later lapse show it again.
- Skip posts nothing and does not show again for that lapse.
- The prompt has no text field (compile-level test on the view model) and its strings contain no TMDB or movie term.
- A member never sees it; owner tier never lapses so never sees it.

**Verification:** KateCore tests green; a sandbox expiry shows the prompt once and the triage page counts it.

### U29. Founding Crews

**Goal:** An honest first-N offer with a real counter and a price lock, Apple-compliant (R44, R48).

**Requirements:** R44, R48; D4; KTD22.

**Dependencies:** U17, U19, U23. **Blocked on Q7** (proposed — awaiting Luke's confirmation of the cap, the perks and the end date).

**Files:**
- `drizzle/migrations/0059_founding_crews.sql` (new), `src/lib/db/schema.ts`, `scripts/expected-tables.txt`
- `src/lib/plus/founding.ts`, `src/lib/plus/founding.test.ts` (new)
- `src/lib/plus/entitlement.ts` (claim in the same batch as the first annual bind; release on full refund or revocation)
- `src/app/api/v1/plus/founding/route.ts` (new, read-only counter)
- `src/lib/plus/config.ts` (`foundingCap`, `foundingEndsAt`; cap 0 means off)
- `ios:Sources/KateCore/Paywall.swift`, `ios:Sources/kate_ios/Plus/PaywallView.swift`, `ios:Sources/kate_ios/Plus/PlusView.swift` (spots line, badge)
- `docs/release-checklist.md` (price-lock steps), `docs/app-store/review-notes.md`

**Approach:**
1. The claim goes to the first N crews whose first annual subscription (Apple or Stripe) binds, written in the same D1 batch as the bind with a guarded insert (KTD22). Monthly buyers are not founders; a crew claims once.
2. The paywall shows "Founding Crew: N of cap spots left" only when the route says `open`, with the fixed end date if one is set; it hides the line when closed. No timer, no "only a few left" wording, no per-visit change. The benefit is stated in plain words ("Your yearly price will not rise while you stay subscribed") next to the normal price, renewal and cancel lines.
3. The price lock: Luke selects "preserve current price for existing subscribers" in App Store Connect on any future increase (Apple applies it to all existing subscribers, so founders are covered along with everyone who subscribed earlier), and any Stripe price change creates a new price id while founders stay on the original. Paywall copy states only the commitment to founders and never claims non-founders will pay more. U29 adds a unit test that no repo price-migration helper moves a founder crew, and the checklist records the setting. A lapse beyond the 30-day grace ends the lock (stated on the paywall and in review notes).
4. The owner's Plus screen shows a "Founding Crew" badge. A credits screen naming founders is not built (it needs personal data).
5. A full refund or revocation deletes the claim so the counter stays true.

**Test scenarios:**
- Covers AE19. Cap 100, 100 claimed: the 101st annual bind makes no claim; a full refund of one claim reopens a spot.
- Two simultaneous annual binds at claimed = cap - 1 produce exactly one claim, and a rank conflict leaves the entitlement bind committed.
- A monthly bind and an owner-tier crew make no claim; a second annual bind by the same crew makes none.
- The founding route returns the same count the claims table holds and nothing else (no crew ids).
- With cap 0 or `isPlusEnabled` off the route and the paywall line are inert.
- The paywall copy test (U23) passes with the founding line present and fails on a countdown string.
- The founding copy contains no claim that non-founders will pay more.
- A founder crew is excluded by the price-migration helper test.

**Verification:** unit tests green three times; a Stripe test-mode annual purchase and a sandbox annual purchase each claim a spot, recorded by Luke in the checklist.

### U30. Gift, referral and affiliate codes

**Goal:** Luke can hand out free time through Apple offer codes and Stripe promotion codes and see how each campaign performs, with no personal tracking (R45).

**Requirements:** R45, R48; D3, D4, D5; KTD23.

**Dependencies:** U17, U19, U23; U20 for the Stripe side.

**Files:**
- `src/lib/plus/codes.ts`, `src/lib/plus/codes.test.ts` (new: closed campaign table)
- `src/lib/plus/notifications.ts` (reads `offerIdentifier` and `offerType` from the verified transaction and calls `bumpGrowth('code_redeemed', key)`)
- `src/lib/plus/stripe/webhook.ts` (maps the session's promotion code id to a campaign key)
- `ios:Sources/kate_ios/Plus/PlusView.swift` (a "Have a code?" row using StoreKit's offer-code redeem sheet), `ios:Sources/KateCore/Paywall.swift`
- `docs/release-checklist.md`, `docs/app-store/review-notes.md`

**Approach:**
1. Luke creates codes in App Store Connect (one-time-use codes for gifts and referrals, a custom code per affiliate) and Stripe promotion codes (`first_time_transaction`, redemption caps, expiry); he gives Claude the offer identifiers and promotion code ids, which go into `codes.ts` under campaign keys.
2. Redemption is counted server-side only, from the data Apple and Stripe already send, by campaign key. The code string, the crew and the person are not stored with the count (R38).
3. The "Have a code?" row sits on the Plus screen, opens Apple's redeem sheet and explains in one line what a code does. It is not shown on the paywall as a downsell, and no giveaway collects contact details. A gift or referral is a code Luke sends by hand; there is no in-app reward ledger.
4. Stripe checkout sets `allow_promotion_codes` (U20) so a code can be typed on the hosted page; a downsell-coupon session (U24) omits it.
5. Exclusion rules among intro trial, win-back and codes are stated in `offers.ts` and follow Apple's one-offer-per-group rule; the app never shows two offers at once.

**Test scenarios:**
- Covers AE20. A verified Apple transaction with a known offer identifier and a Stripe session with a known promotion code each bump `code_redeemed` with the right key and store no code string or crew id.
- An unknown identifier bumps nothing and is logged.
- A client post of `code_redeemed` is rejected (U19 test, referenced).
- The redeem row is hidden for members, owner tier and self-hosted servers.
- The row's and sheet's strings contain no price promise Apple would own and no TMDB term.

**Verification:** a sandbox offer-code redemption and a Stripe test-mode promotion code checkout, each shown as a campaign count on the triage page, recorded by Luke.

### U31. Year in Review (Plus)

**Goal:** One outcome feature that raises the dream outcome for crews that already get value, with no AI and no TMDB (R46).

**Requirements:** R46, R41; D6; KTD19, KTD24.

**Dependencies:** U23 (features gate). **Blocked on Q5** (proposed — awaiting Luke's confirmation); the free tier keeps everything it has today either way.

**Files:**
- `ios:Sources/KateCore/YearInReview.swift` (new: selection and layout model), `ios:Tests/KateCoreTests/YearInReviewTests.swift` (new)
- `ios:Sources/kate_ios/Plus/YearInReviewView.swift` (new: SwiftUI layout and PDF render), `ios:Sources/kate_ios/Plus/PlusView.swift` (entry point)
- `src/lib/plus/features.ts` (adds `year_in_review`)

**Approach:**
1. Build the model on the device from entries, photos, videos, walks and plans of the crew for a calendar year: counts, the month with the most photos, the longest walk, the first entry of each month, and up to nine photos picked by a fixed rule (earliest photo in each month). No model call and no server call.
2. Drop movie and TV rows by type before anything is computed, and show no hours-watched or rating figures. If the Insights plan's aggregation has merged, reuse its bucketing and exclude its watch cards.
3. Render to a PDF with the SwiftUI renderer and offer the share sheet. The Plus gate (`gate_year_in_review`) applies to the PDF and the full layout; a free crew sees a preview with the counts only and an upgrade row, and can still export all of its data, as always. Available from 1 December for the running year, and for past years at any time.
4. The paywall variant never mentions movies or recommendations (R41), and App Review notes say the feature contains no TMDB data.

**Test scenarios:**
- Covers AE21. A crew with 40 entries, 120 photos, 6 walks and 12 movie ratings produces a model with the first three and none of the ratings; a movie-typed row is dropped by type in a test over all row kinds.
- The same input always yields the same model and photo picks (determinism).
- A crew with no walks omits that page and still renders; an empty year shows the empty state.
- A free crew gets the preview and the gate; an owner-tier crew gets the full feature; export is unaffected (test asserts no limit read in the export path).
- No string in the feature contains "movie", "film", "TMDB" or "recommend".

**Verification:** KateCore tests on Linux; on a device build the PDF opens with the expected pages, recorded by Luke in the checklist.

### U32. Landing page with isolated Meta Pixel and Conversions API

**Goal:** The Meta Option B landing page exists on its own origin with honest disclosure, and nothing from it reaches the app (R47).

**Requirements:** R47; D5, D6; KTD25.

**Dependencies:** U21 (the privacy page edit follows U21's rewrite). Meta spend still waits on App Store approval, Plus live and Luke's Meta actions (spend gate in U26).

**Files:**
- `marketing/index.html`, `marketing/consent.js`, `marketing/pixel.js`, `marketing/functions/capi.ts` (new: the Conversions API relay), `marketing/wrangler.jsonc`, `marketing/README.md`
- `src/app/(public)/privacy/page.tsx` (adds the landing-page Pixel paragraph and scopes the "no trackers" claim to the app)
- `scripts/test/no-pixel-in-app.sh` (new: scan test), `docs/app-store/privacy-labels.md` (a line that the label is unchanged and why)
- `docs/release-checklist.md`

**Approach:**
1. One page: core promise, the three angles from the GTM plan with real UI images, no pricing, one "Get Kate" button to the App Store campaign link (`ct` token per ad set), copy that describes the product and never the viewer, 18+ only.
2. A consent choice before the Pixel loads; without consent neither the Pixel nor the relay fires. The relay sends `PageView` and the "Get Kate" click with a shared `event_id`; secrets `META_PIXEL_ID` and `META_CAPI_TOKEN` are Worker secrets on the marketing project only.
3. No landing visit id is joined to an install or an account; install counts come from App Store Connect campaign links.
4. The website privacy policy states what the Pixel and the relay send, who receives it and how to opt out, and says "the Kate app contains no third-party trackers"; the app's privacy label and manifest are untouched.
5. `scripts/test/no-pixel-in-app.sh` fails if `fbq`, `connect.facebook.net`, `graph.facebook.com` or Meta Business SDK strings appear in `src/`, the iOS target or the built API Worker bundle, and runs in CI.

**Test scenarios:**
- Covers AE22. The scan test passes on the repo and fails on a seeded `fbq(` line in `src/`.
- With consent withheld the page makes no request to a Meta host; with consent it sends one `PageView` carrying an `event_id` and the relay sends the same id.
- The relay rejects any event name other than the two it knows and any body with extra fields.
- The privacy page contains the Pixel paragraph and the scoped app claim; the privacy-label mirror and manifest test are unchanged.
- The page has no pricing string and no second-person relationship claim (copy test).

**Verification:** the scan test green; the landing page renders in the web screenshot run; Luke checks the Pixel with Meta's Events Manager test events after the domain is verified.

---

## Luke actions

Nothing in this list can be done by Claude; each blocks the named unit's live test, the launch slice or the U26 gate. Items marked **(slice)** gate the 2026-10-26 launch slice.

**App Store Connect and Apple**
1. **(slice)** Accept the Paid Apps Agreement and complete tax and banking (blocks any purchase).
2. **(slice)** Enroll in the App Store Small Business Program before the first sale; check the effective date in Apple's current terms, since the GTM revenue math assumes the 15% rate.
3. **(slice)** Create the subscription group and products `app.kate.plus.monthly` and `app.kate.plus.yearly` (ids already in `PLUS_PRODUCT_IDS`), Family Sharing off, prices from Q2, localizations and review screenshot.
4. **(slice)** Create the introductory offer (default: 7-day free trial on yearly).
5. Create the win-back offer for lapsed subscribers (suggested: 3 months at about half price, pay as you go) and give Claude the offer id (U24, after Q3 is confirmed). No promotional-offer key is needed.
6. **(slice)** Set the App Store Server Notifications V2 URL (production and sandbox) to `/api/appstore/notifications`.
7. **(slice)** Create sandbox tester accounts and add the App Review test user ids to `KATE_PLUS_SANDBOX_ACCOUNTS`.
8. **(slice)** Update the App Privacy answers: add Usage Data > Product Interaction, not linked, not tracking, Analytics (U21). The label does not change for the landing-page Pixel (U32).
9. **(slice)** Paste the updated review notes for the slice build (Switch server stays visible under Advanced until U25 ships). As each unit ships, add its statements: the hidden BYO entry and its reveal (U25), the offers, offer codes, Founding Crews and Year in Review.
10. Create offer codes for gifts, referrals and affiliates (one-time-use batches and custom codes) and give Claude the offer identifiers and campaign names (U30).
11. If Founding Crews is confirmed (Q7), set "preserve current price for existing subscribers" on any future price increase and record it in the checklist (U29).
12. Create the App Store Connect campaign links (`pt`, `ct`) and two custom product pages for ads (journal, walks).

**Stripe**
13. Create or verify the Stripe account for Kate and enable Apple Pay on the web for Checkout.
14. Create the product and the monthly and yearly prices (live and test; after Q6), the 3-month repeating downsell coupon, Stripe promotion codes for affiliates and gifts, and the Billing Portal configuration (cancel allowed, optional cancel-offer coupon).
15. Create the webhook endpoint `/api/stripe/webhook` for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`; give Claude nothing in chat, store `STRIPE_SECRET_KEY` (restricted key), `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` in omaseal and set them as Worker secrets.
16. Decide tax handling (Stripe Tax or none for launch) and the refund policy text.

**Marketing and spend**
17. Choose and own the landing-page domain for U32 (not the API subdomain) and point it at the marketing Cloudflare project.
18. Create the Meta Business Portfolio (Business Manager), the Facebook Page "Kate", the Instagram professional account, the ad account and the Pixel dataset; verify the landing domain; create the Conversions API token and store it in omaseal as `META_CAPI_TOKEN` (and `META_PIXEL_ID`); set an account spending limit of $450.
19. **Approve the ad budget:** $450 Meta cap plus a small Apple Ads test (the GTM plan proposes $5/day, about $140 over 28 days; the roadmap's $500 monthly guard means $450 Meta plus about $50 Apple unless Luke widens the guard). Nothing is spent until the U26 spend gate is signed.
20. Create the Apple Ads account (linked to the app) and the TikTok and Instagram creator accounts; confirm Option B (no SDK) and the exact "no third-party trackers in the app" wording for the website.

**Decisions and external**
21. Confirm, or change, the proposed defaults: Q3 (monthly downsell, win-back, Stripe 3-month coupon), Q5 (Year in Review), Q6 (price parity, 30-day review) and Q7 (Founding Crews: cap 100, price lock, badge, end date), plus Q2 prices and trial length and Q4 before U16 starts.
22. Confirm the Apple US external-link rule reading (Q1) before U23 enables the web option.
23. **(slice)** Record the R13 precondition (TMDB written answer or `KATE_MOVIE_SOURCE=wikidata`) before any flag flip.
24. **(slice)** Confirm no other session (Devin) deploys during each U15 pass window, and approve each production migration and deploy.
25. Run the sandbox, Stripe test and lapse drills listed in the U26 checklist and mark them done, and sign the spend gate when App Store approval and Plus are both live.

---

## Verification Contract

Same gates as the launch plan, with these additions.

| Gate | kate command | kate-ios command | Applies to |
|---|---|---|---|
| Lint, types, unit tests | `npm run lint`, `npm run typecheck`, `npm test` | `KATE_CORE_ONLY=1 swift test` | every unit |
| D1 migration check | `scripts/test/d1-migrations-check.sh` | none | U16, U17, U19, U29 (U20 and U24 read the 0057 table) |
| Build | `npm run build` and `npm run build:cloudflare` | `xcodebuild build` on the macOS build host, with and without `KATE_PLUS=1` | every unit |
| Web e2e | `npx playwright test -c e2e` | none | U22, U20 return page, U25 docs, U28 return state, U32 landing page |
| No tracker in the app | `scripts/test/no-pixel-in-app.sh` | the same scan over the iOS target | U32 and every unit (CI) |
| iOS UI tests | none | `xcodebuild test -scheme kate_iosUITests` on the macOS build host | U23, U25, U31 |
| Determinism | each suite three times on one commit | same | U20, U23, U29, U31 |
| Production preflight | `scripts/ops/preflight.sh` | none | U26, before every production step |

Each command's exit code is checked on its own, and no merge shares a command with tests.

## Definition of Done

- Every unit's verification outcome holds and its tests are green on the self-hosted runners.
- `default` is `owner`, no crew is `grandfathered`, and the trigger prevents it.
- A sandbox purchase, a Stripe test purchase and a lapse drill all end in the expected `crew_plans` state with data intact.
- The digest has delivered a real funnel block; privacy label and privacy page match what the app sends.
- BYO is hidden, disclosed and guided, and free of any plan limit.
- The launch slice is merged and its checks pass; no spend started before App Store approval and Plus were live (the spend gate in U26 is signed).
- Each Phase B unit is either merged dark with its checklist section passed, or still blocked on its named Question, and none was switched on without it.
- The member-cap finding is corrected everywhere (6 for Free, 12 for Plus) and paywall copy lists it.
- The landing-page scan test passes and the website privacy page discloses the Pixel; the app's privacy label is unchanged by it.
- Plus is still off in production until U26's checklist is complete; no migration or deploy happened outside U15.
