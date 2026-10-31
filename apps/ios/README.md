# tallyline-ios

Native Tallyline client for iPhone and iPad — SwiftUI, SwiftPM package plus an
`xcodegen` shipping target, mirroring the `kate-ios` layout.

## Layout

- `Sources/TallylineCore` — pure-Foundation API client, pairing/auth, models.
  Builds and tests on Linux: `TALLYLINE_CORE_ONLY=1 swift test`.
- `Sources/TallylineDesign` — Silver Lining tokens and shared SwiftUI (iOS only).
- `Sources/tallyline_ios` — the app target (`@main` lives here).
- `Sources/XcodeStub` — empty anchor the generated app target compiles; real
  code ships from the package.
- `project.yml` — `xcodegen generate` produces `Tallyline.xcodeproj` (not committed).
- `scripts/testflight.sh` — archive, export, dSYM keep, upload (macOS only,
  run by `.github/workflows/ios-release.yml`, or by hand on any Mac).
- `scripts/xcode-plist.sh` — writes `build/Info.xcode.plist` with build-setting
  variables before every xcodebuild.

## Auth

Pairing-code first: Settings → Devices in the web app (or `tallyline pair`)
mints a 5-minute code; the app redeems it at `POST /v1/auth/pair/redeem` for a
`tly_pat_` device credential kept in the Keychain. Web sign-in plus a pasted
server URL covers the self-hosted path. OAuth access tokens are audience-bound
to `/mcp` and cannot call `/v1`, so there is no in-app OAuth flow.

## Offline

Reads come from a local issue cache first, then a delta sync (`updatedSince`) merges changes. Every write (new issue, edit, comment) goes through the outbox in `TallylineCore/Outbox.swift`:

- Each entry's id is its `Idempotency-Key`, so a replay after a lost response applies once.
- Writes to the same issue send strictly in order; other issues are not held up.
- Network errors, 409, 429 and 5xx retry from 1 s, doubling to 5 minutes, up to 8 tries. Then the entry parks.
- Any other 4xx (for example editing an issue cancelled elsewhere) parks at once with the server's reason. The server's state wins.
- Parked entries wait in Settings > Outbox for Retry or Discard. Sign-out wipes the queue and the cache.

Both are JSON files written atomically under Application Support. The plan named SwiftData; a JSON file keeps the logic testable on Linux and needs no migrations at this size.

## Push

`TallylineCore/Push.swift` holds the registration flow and preferences (tested on Linux). `tallyline_ios/PushViews.swift` holds the app delegate, permission prompt and Settings > Notifications. The flow and privacy model are in [docs/push.md](../../docs/push.md). `App.entitlements` carries `aps-environment`, so the App ID needs the Push Notifications capability.

## Widgets

`Extensions/Widgets` is a WidgetKit extension with three widgets: My issues, Needs your review, and Cycle progress, in Home Screen and Lock Screen sizes. The app writes `WidgetSnapshot` (built in `TallylineCore/WidgetSnapshot.swift`, tested on Linux) to the App Group `group.app.tallyline.ios` on launch and when it goes to the background. The widget only reads that file; it never calls the network. Lock Screen sizes show counts only, never titles. Taps open `tallyline://open/issues` or `tallyline://open/review`.

The App Group must be registered and added to both App IDs (`app.tallyline.ios`, `app.tallyline.ios.widgets`) before a signed build installs. The xtool sideload path builds the app without extensions.

## Wire contract

`Tests/TallylineCoreTests/Fixtures/*.json` are real responses captured from the API routes by `apps/api/src/routes/ios-contract.test.ts`. That test fails when a route's shape drifts from its fixture; the Swift `ContractFixtureTests` decode every fixture on Linux. After an intended API change, refresh them:

```sh
IOS_FIXTURES=write pnpm --filter @tallyline/api exec vitest run src/routes/ios-contract.test.ts
```

## Building

Shipping builds run in GitHub Actions on a macOS runner (`.github/workflows/ios-release.yml`,
Xcode + `xcodegen` + an App Store Connect API key held as repository secrets).
Every pull request that touches `apps/ios` is compiled and tested by
`.github/workflows/ios.yml`. `xtool` on a Linux machine stays the inner-loop
install to a registered phone. See the S5 stage in
`docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md`.
