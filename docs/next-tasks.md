# Next tasks

Heaviest open work, ordered by impact. Every item comes from the "Open: needs Luke" table in [ROADMAP.md](../ROADMAP.md). An agent can prep and verify each one, but Luke has to supply the input listed for it.

1. **S5 Apple setup and first TestFlight build**
   - What: S5-U1 sets up the App IDs: the app with Push Notifications and the `group.app.tallyline.ios` App Group, plus the widgets and share extension IDs. S5-U8 is the first TestFlight upload.
   - Files: `apps/ios` (`project.yml`, `App.entitlements`, `Extensions/`, `ci/`, `scripts/`, `README.md`).
   - Luke provides: Apple Developer account access, the App IDs and App Group, and signing and App Store Connect API credentials.
   - Verify: the iOS CI build passes, the build shows up in TestFlight, and it installs and pairs on a device.
2. **S4 production push relay**
   - What: run `apps/push-relay` in production with the Apple push key, then send one sandbox push to a test build.
   - Files: `apps/push-relay`, `docs/push.md`.
   - Luke provides: the APNs auth key and where to host the relay.
   - Verify: follow the steps in `docs/push.md`. The test build gets the push, and tapping it opens the right screen.
3. **U3 restricted deploy user**
   - What: create a restricted deploy user, then do the first `ops/deploy.sh --assume-running` run (#188).
   - Files: `ops/deploy.sh`, `ops/deploy.test.sh`, `docs/deploy.md`.
   - Luke provides: host access to create the user, and approval for the first run.
   - Verify: `ops/deploy.test.sh` passes, the deploy finishes as the new user, and the status endpoint is healthy.
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
    - What: external TestFlight, the store listing, and submission. Do this after item 1.
    - Files: `apps/ios`, plus store assets in `assets/`.
    - Luke provides: listing copy, screenshots approval, and the submit decision.
    - Verify: the build passes App Review.
