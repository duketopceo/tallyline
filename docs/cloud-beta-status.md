# Cloud beta: done / left for owner

Status as of 2026-11-07 against [the roadmap plan](./plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md). Scope: cloud beta without Stripe. Nothing here has been deployed, tagged or released.

## Done (merged to `main`)

| Unit | PR |
| --- | --- |
| U1 land iOS stack, reconcile docs | #245, #246, #250 |
| U3 write contract C6 (`If-Match`, `STALE_WRITE`) | #256 |
| U4 team change, key aliases, issue url | #255 |
| U5 iOS closers (team pill, Copy link, Blocked rotor, snap-scroll) | #253 |
| U7 iOS extras (workspace switching, test notification, feedback, icons) | #254 |
| U8 CLI parity and doctor | #252, #259 |
| U9 readiness pass (first version) | #257 |
| Settings redesign, AI assist default, OpenRouter SDK | #258, #260, #263 |

## Open PRs from this run (not merged)

- Atomic team + state PATCH: a refused transition (409) or agent review approval (403) can no longer leave the issue moved but not transitioned.
- U6 web Sign in with Apple and linked sign-in methods (needs the owner's Services ID before it shows on the login page).
- This status doc.

Pending from earlier: #264 auto-deploy on merge (read it before merging), TLY-266 backups and restore drill, TLY-281 deploy lock and provenance.

## Left for the owner

1. **Merge** the open PRs (order below), after CI is green.
2. **Decide deploy ownership**: fill the table in [deploy.md](./deploy.md#deploy-ownership). Nothing deploys itself until #264 merges, and then every merge to `main` deploys, so merge #264 last or not at all.
3. **Apple console (web)**: create a Services ID, register the API domain and return URL `https://<api-host>/v1/auth/oauth/apple/callback`, create a Sign in with Apple key. On the host set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (see [auth.md](./auth.md#apple-web)). Check: the login page shows "Sign in with Apple".
4. **Backups and restore drill** (TLY-266): review and merge, then run the drill from [deploy.md](./deploy.md#backup--restore) and record the date.
5. **Restricted deploy user, push relay, associated domains** (U10, owner-only): follow [next-tasks.md](./next-tasks.md) in its order; each item lists the input to supply and the check that proves it.
6. **TLY-282 / TLY-290** (owner-only): pending the owner.
7. **U2 device checks** (needs a device), on one iPhone and one iPad, then record dated pass/fail:
   - VoiceOver reads each issue row as one sentence; the rotors "Urgent and high", "In review", "Agent work" and "Blocked" move between rows.
   - Largest Dynamic Type: issue key and title keep a line each; the composer does not overlap.
   - Reduce Motion on: no sliding or bounce transitions.
   - Cold launch from a push lands signed in.
   - Offline: the outbox strip appears; a parked write shows its failure and a Retry action.
   File every defect as an issue.
8. **Day-in-the-life** after deploy: sign in with Apple on web and phone, create, edit offline, reconnect, resolve a stale write, move a team, copy and open a link, connect an agent over MCP, intake one report. File failures as issues, then check the Definition of Done boxes in [CE-PLAN.md](./plans/CE-PLAN.md).

Skipped by owner decision: U11 (environment gate), U12 (board sync), Stripe.

## Merge order

Atomic PATCH fix, then U6, then this doc (independent of each other; U6 and the fix touch different files). #264 last, only once deploy ownership is decided.

Run to verify locally: `pnpm --filter @tallyline/api test` (needs `DATABASE_URL` pointing at a disposable test database).
