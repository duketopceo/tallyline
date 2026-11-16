# Cloud beta: done / left for owner

Status as of 2026-11-16 against [the roadmap plan](./plans/2026-11-04-1847-feat-tallyline-cloud-beta-roadmap-plan.md). Scope: cloud beta without Stripe. tallyline.app auto-deploys from `main`. The latest iOS TestFlight tag is `ios-v1.2.1`.

## Done (merged to `main`)

| Unit | PR |
| --- | --- |
| U1 land iOS stack, reconcile docs | #245, #246, #250 |
| U3 write contract C6 (`If-Match`, `STALE_WRITE`) | #256 |
| U4 team change, key aliases, issue url | #255 |
| U5 iOS closers (team pill, Copy link, Blocked rotor, snap-scroll) | #253 |
| U6 web Sign in with Apple and linked sign-in methods (live button waits on the Apple Services ID and host env) | #266, tests #278 |
| U7 iOS extras (workspace switching, test notification, feedback, icons) | #254 |
| U8 CLI parity and doctor | #252, #259 |
| U9 readiness pass (docs; walkthrough still needs OQ4) | #257 |
| Settings redesign, AI assist default, OpenRouter SDK | #258, #260, #263 |
| Auto-deploy on merge to `main` | #264, backup-path/env fixes #274, #279 |
| Atomic team + state PATCH | #265 |

## Open PRs

None as of 2026-11-16.

## Left for the owner

1. **Apple console (web and iOS):** enable Sign in with Apple on the iOS App ID, create a Services ID, register the API domain and return URL `https://<api-host>/v1/auth/oauth/apple/callback`, create a Sign in with Apple key. On the host set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, and `APPLE_BUNDLE_IDS` to the iOS bundle ID (see [auth.md](./auth.md#apple-web)). Native tokens use the bundle ID as `aud`; without `APPLE_BUNDLE_IDS` the phone gets `401 INVALID_APPLE_TOKEN`. Check: the login page shows "Sign in with Apple", and a phone can sign in to `api.tallyline.app` without a pairing code.
2. **TestFlight 1.2.1:** the tag and upload already succeeded ([run](https://github.com/duketopceo/tallyline/actions/runs/43846459344), [release](https://github.com/duketopceo/tallyline/releases/tag/ios-v1.2.1)). Confirm pairing and sync of that build on a device.
3. **Backups and restore drill** (TLY-266): run the drill from [deploy.md](./deploy.md#backup--restore) and record the date.
4. **Push relay, associated domains**, and the rest of the owner list in [next-tasks.md](./next-tasks.md).
5. **Fill the deploy ownership table** in [deploy.md](./deploy.md#deploy-ownership).
6. **TLY-282 / TLY-290** (owner-only): pending the owner, if those still apply.
7. **U2 device checks** (needs a device), on one iPhone and one iPad, then record dated pass/fail:
   - VoiceOver reads each issue row as one sentence; the rotors "Urgent and high", "In review", "Agent work" and "Blocked" move between rows.
   - Largest Dynamic Type: issue key and title keep a line each; the composer does not overlap.
   - Reduce Motion on: no sliding or bounce transitions.
   - Cold launch from a push lands signed in.
   - Offline: the outbox strip appears; a parked write shows its failure and a Retry action.
   File every defect as an issue.
8. **Day-in-the-life** after Apple console setup: sign in with Apple on web and phone, create, edit offline, reconnect, resolve a stale write, move a team, copy and open a link, connect an agent over MCP, intake one report. File failures as issues, then check the Definition of Done boxes in [CE-PLAN.md](./plans/CE-PLAN.md).
9. **Close or keep** issues #232–#237 and #239 after confirming the intake work in #240 covers them.

Skipped by owner decision: U11 (environment gate), U12 (board sync), Stripe.

U3 (restricted deploy user / first `--assume-running` run) is no longer an owner gate: auto-deploy is live. See [next-tasks.md](./next-tasks.md#done-since-the-2026-11-05-pass-not-owner-work-any-more).

Run to verify locally: `pnpm --filter @tallyline/api test` (needs `DATABASE_URL` pointing at a disposable test database).
