# tallyline-ios

Native Tallyline client for iPhone and iPad — SwiftUI, SwiftPM package plus an
`xcodegen` shipping target, mirroring the `kate-ios` layout.

## Layout

- `Sources/TallylineCore` — pure-Foundation API client, pairing/auth, models.
  Builds and tests on Linux: `TALLYLINE_CORE_ONLY=1 swift test`.
- `Sources/TallylineDesign` — Silver Lining tokens and shared SwiftUI (iOS only).
- `Sources/tallyline_ios` — the app target (`@main` lives here).
- `AppTarget` — the few sources compiled in the Xcode app target itself: the
  anchor file and App Intents (Xcode only extracts intent metadata there).
  Everything else ships from the package.
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

## Share sheet

`Extensions/Share` adds Tallyline to other apps' share menus. It takes a link or text, prefills a title and notes (`TallylineCore/Share.swift`), and files a triage issue to the team last used. Online, it sends at once. Offline, it writes the issue to `share-inbox/` in the App Group; the app moves it into its outbox with the same id (the idempotency key) when it next opens, so nothing is filed twice.

The device credential lives in the App Group keychain access group so the extension can read it. Older installs move their credential into the group on first launch. Images are not accepted: the API has no attachments yet.

## Shortcuts

`AppTarget/Intents.swift` adds three App Shortcuts: Create issue, Open issues, and Open issue by key (`eng 12` works; parsing is `TallylineCore/IssueKey.swift`). Create issue goes through the outbox, so it works offline, and files to the team last used in the app (`TeamMemory`). Siri voice phrases come with App Shortcuts but are not tuned yet. The xtool sideload path builds without them.

## Accessibility

- VoiceOver reads each issue row as one sentence (`IssueSpeech` in TallylineCore): key, title, state, then priority, agent and repeat count. The issue list has "Urgent and high" and "Agent work" rotors.
- Text uses Dynamic Type styles only; the agent glint scales with it, and row titles get more lines at accessibility sizes.
- `ContrastTests` checks the generated tokens against the DESIGN.md floors in light, dark and high-contrast dark (4.5:1 text, 3:1 glyphs).
- The app has no custom animation, so Reduce Motion needs nothing extra. Haptics fire only for a finished create or review, or a failed review.
- CI runs Xcode's accessibility audit on the sign-in screen, at default and the largest text size.
- Strings are SwiftUI literals and `SWIFT_EMIT_LOC_STRINGS` is on, so a string catalog can be added without code changes. English only ships.

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
