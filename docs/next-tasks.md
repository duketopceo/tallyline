# Next tasks

Heaviest open work, ordered by impact. Most items still need an input from Luke. An agent can prep and verify each one, but Luke has to supply the input listed for it. Auto-deploy is already live and is not in this list.

## Agent-buildable (no Luke input)

1. **W3 public pricing copy** (CE-PLAN W3 / R6)
   - What: replace the landing page's "hosted plans are not available yet" block with the settled list: Free, Pro $8 / Business $14 per seat per month when billed yearly ($10 / $16 billed monthly), and self-host free. Do not add a buy button or turn `BILLING` on.
   - Files: `apps/web/components/landing/copy.ts`, `apps/web/components/landing/landing.tsx`, `apps/web/components/landing/copy.test.ts`. Limits must match `apps/api/src/plans.ts`.
   - Luke provides: nothing for copy. Checkout and Stripe are C3, later.
   - Verify: copy tests pass; the page states the four prices and "self-host free"; no "AI" in landing copy; no buy or subscribe control.

2. **I5 agent-first iOS home** (#238)
   - What: make `Home` the app root: active projects as cards, a compact agents-working strip, issues as a tab.
   - Files: `apps/ios`, plan U7 in [docs/plans/2026-11-03-1600-feat-intake-helpdesk-agent-first-home-plan.md](./plans/2026-11-03-1600-feat-intake-helpdesk-agent-first-home-plan.md).
   - Luke provides: nothing to start the build; a device check after it lands.
   - Verify: `TALLYLINE_CORE_ONLY=1 swift test` where applicable; home orders projects by activity and has an empty state.

## Needs Luke

1. **Apple console (OQ4)** so live Sign in with Apple works
   - What: enable Sign in with Apple on App ID `app.tallyline.ios` (or the current bundle), create a Services ID for web with return URL `https://<api-host>/v1/auth/oauth/apple/callback`, and set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` on the host.
   - Files: [docs/auth.md](./auth.md). Code is already on `main` (#266, tests #278).
   - Luke provides: the Apple Developer / App Store Connect setup and the host env values (never commit them).
   - Verify: the web login page shows "Sign in with Apple", and a phone can sign in to `api.tallyline.app` without a pairing code.

2. **S5 TestFlight: cut 1.2.1 and confirm on a device**
   - What: `apps/ios` has two commits since `ios-v1.2.0`: #281 (offline share fix — the only product change) and #278 (Apple sign-in contract fixture tests only). The `ios` workflow on `main` is green. Tag `ios-v1.2.1` on `main` to start `.github/workflows/ios-release.yml`; it waits on the `testflight` environment.
   - Files: `apps/ios` (`project.yml`, `App.entitlements`, `Extensions/`, `ci/`, `scripts/`, `README.md`).
   - Luke provides: approval of the `testflight` environment, then a pairing and sync check on a device.
   - Verify: the build shows up in TestFlight, and it installs and pairs (and, once OQ4 is set, signs in with Apple).

3. **S4 production push relay**
   - What: run `apps/push-relay` in production with the Apple push key, then send one sandbox push to a test build.
   - Files: `apps/push-relay`, `docs/push.md`.
   - Luke provides: the APNs auth key and where to host the relay.
   - Verify: follow the steps in `docs/push.md`. The test build gets the push, and tapping it opens the right screen.

4. **U2 backups**
   - What: decide who holds the age key, turn on bucket object lock, enable the timer, and run the restore drill (#165, #172, #178).
   - Files: `ops/backup.sh`, `ops/restore.sh`, `ops/systemd/tallyline-backup.{service,timer}`.
   - Luke provides: the age key custody decision, bucket credentials, and object lock settings.
   - Verify: `systemctl list-timers` shows the timer, one backup lands in the bucket, and the restore drill brings the data back on a scratch database.

5. **S2 publish images and the installer**
   - What: publish the images and make them public, host and pin the installer, then do the Homebrew tap, the Railway template, a clean-machine run, and the S2-U6 reachability spike.
   - Files: `tools/install`, `deploy/railway`, `docker-compose.selfhost.yml`, `docs/releasing.md`.
   - Luke provides: registry and Railway accounts, a domain for the installer, and a clean machine.
   - Verify: on a clean machine, the installer finishes and `/welcome` loads. The Railway template deploys too.

6. **S1 live `connect` and `doctor`**
   - What: run `connect` and `doctor` against the hosted server.
   - Files: `tools/cli`.
   - Luke provides: the hosted server URL and a browser sign-in.
   - Verify: `doctor` reports every check green.

7. **S3 live OpenRouter run**
   - What: answer open questions 4 and 5, set a spend cap, and do one live Connect OpenRouter run on a capped account.
   - Files: the provider code in `apps/api`, plus `docs/research/2026-10-ai-providers-spike.md`.
   - Luke provides: the answers, a capped OpenRouter account, and the spend limit.
   - Verify: the connect flow completes, one agent action works, and spend stays under the cap.

8. **U11 Kate import**
   - What: run the import using the credential from OQ5.
   - Files: `docs/import.md`, and the import CLI in `tools/cli`.
   - Luke provides: the import credential, and approval for each write.
   - Verify: do a dry run first, then do each write only after Luke approves it. Check the counts against the source.

9. **U6 production host cleanup**
   - What: delete the orphan redis volume, the dangling swarm records, and the `.env.bak-*` files.
   - Files: none (all on the host).
   - Luke provides: a yes on each deletion.
   - Verify: list everything before deleting, and confirm the services are still healthy afterward.

10. **U21 mobile web check**
    - What: check the installed web app on a phone.
    - Files: `apps/web`.
    - Luke provides: a phone.
    - Verify: it installs to the home screen, and sign-in and the board work.

11. **S7 App Store**
    - What: external TestFlight, the store listing, and submission. Do this after a current TestFlight build is confirmed.
    - Files: `apps/ios`, plus store assets in `assets/`.
    - Luke provides: listing copy, screenshots approval, and the submit decision.
    - Verify: the build passes App Review.

12. **Deploy ownership table**
    - What: fill the empty table in [docs/deploy.md](./deploy.md#deploy-ownership).
    - Files: `docs/deploy.md`.
    - Luke provides: who deploys each surface, how a deploy is announced, and how it is verified.
    - Verify: the table has a row for the API host, the web front end, and the push relay.

## Done since the 2026-11-05 pass (not owner work any more)

- **U3 deploys.** `.github/workflows/deploy.yml` auto-deploys tallyline.app on every push to `main` except docs, markdown, and `apps/ios/` (#264). The self-hosted runner (`self-hosted,tallyline-deploy`) runs `ops/deploy.sh` on the production host. #274 and #279 fixed the backup path and the host backup env; the deploy for #279 succeeded on 2026-11-13 at 1:46 AM MST. The first manual `ops/deploy.sh --assume-running` run is superseded. A tighter sudoers-restricted deploy user on the host is optional hardening, not a gate.
- Cloud beta units #256 (U3/C6), #255 (U4), #253 (U5), #258 (Settings redesign), and #266 (U6 web Apple sign-in, live button still waiting on OQ4).
- Intake, helpdesk, and the secrets-key callout (#240). Issues #232–#237 and #239 are still open and look done; they need a close/keep pass.

## Readiness pass 2026-11-16 (cloud beta)

State: `main` is at `929142b`. No pull requests are open. Auto-deploy is live; the last server deploy that ran was #279 and it passed. Later merges #277 (docs/prototype) and #281 (iOS) correctly skipped the deploy workflow. The latest TestFlight tag is still `ios-v1.2.0` (2026-11-07); #281 is the first product iOS change since then. The Definition of Done in [CE-PLAN.md](./plans/CE-PLAN.md) has no boxes checked: live Apple sign-in is not confirmed, pricing copy is still the placeholder, and device checks have not been recorded.

Owner steps, in order:

1. **Apple console (OQ4)** so the web button shows and a phone can sign in without pairing.
2. **Approve the `testflight` environment** after `ios-v1.2.1` is tagged, then confirm the build on a device.
3. **Backups and restore drill** (U2).
4. **Device checks (cloud-beta U2):** VoiceOver and on-device checks of the iOS shell, skipped for now because they need a device.
5. **Push relay** so the Settings test notification row can be exercised.
6. **Fill the deploy ownership table.**
7. **Close or keep** issues #232–#237 and #239 after confirming #240 covered them.

### Day-in-the-life walkthrough (U9)

The merges it was waiting on are on `main`, and tallyline.app is being auto-deployed. It is still not fully runnable until OQ4 is set (web and phone Sign in with Apple). Run it after that, then file failures as issues.

1. Sign in with Apple on web and on the phone.
2. Create an issue; edit one offline.
3. Reconnect and let the outbox drain.
4. Resolve one stale write (409 `STALE_WRITE`).
5. Move an issue to another team.
6. Copy a link and open it.
7. Connect an agent over MCP.
8. Intake one report.

Also run the plan's Verification Contract end to end after the Apple console work.
