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
  run via `~/bin/testflight tallyline` on the release machine).
- `scripts/xcode-plist.sh` — writes `build/Info.xcode.plist` with build-setting
  variables before every xcodebuild.

## Auth

Pairing-code first: Settings → Devices in the web app (or `tallyline pair`)
mints a 5-minute code; the app redeems it at `POST /v1/auth/pair/redeem` for a
`tly_pat_` device credential kept in the Keychain. Web sign-in plus a pasted
server URL covers the self-hosted path. OAuth access tokens are audience-bound
to `/mcp` and cannot call `/v1`, so there is no in-app OAuth flow.

## Building

Shipping builds run on the Mac mini over `ssh mini` (Xcode + `xcodegen` +
App Store Connect API key); `xtool` on omarchy-max stays the inner-loop install
to a registered phone. See the S5 stage in
`docs/plans/2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md`.
