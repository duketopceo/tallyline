---
title: iOS App — Tallyline companion (SwiftUI, OAuth, TestFlight)
date: 2026-10-12
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# iOS App — Tallyline companion

> **Superseded in part (2026-10-28).** The staged program in [2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md](./2026-10-28-0200-feat-ios-client-agent-providers-cli-plan.md) carries these units forward (see its mapping table), builds on the Mac mini instead of xtool alone, and brings push, widgets, share sheet and offline writes into scope.

## Goal Capsule

**Objective:** A Tallyline user can sign in on an iPhone and work the full tracker — triage, board, projects, cycles, issue create/edit/comment — against `api.tallyline.app` or any self-hosted instance, installed on their registered devices.

**Prerequisites:** `xtool` ≥1.21 (`github.com/xtool-org/xtool`; installed at `~/.local/bin/xtool`, proven by the user's `kate-ios` app — a separate SwiftUI app already built/signed/installed from this machine via the paid developer account). The toolchain needs `xtool setup` + `xtool auth` once per machine/account.

**Means:** Native SwiftUI app in `apps/ios`, authenticated via the existing OAuth 2.1 authorization server (RFC 7591 DCR + auth code + PKCE + refresh tokens) (KTD2).

**Authority hierarchy:** This plan > `ROADMAP.md` U15 row > `DESIGN.md` visual contract > generic iOS conventions. Where the plan and the shipped API disagree, the API is fixed unless a unit explicitly changes it.

**Stop conditions:** Any change to OAuth grant semantics beyond redirect-URI validation; any requirement for server-side session state on iOS; a need for APNs before TestFlight v1.

**Execution profile:** `ce-work`, one U at a time; U1 ships independently to `apps/api`; U2–U7 are app-side and can run sequentially on one branch. All app builds run locally via **xtool** — no macOS/Xcode required.

---

## Product Contract

### Summary

Tallyline is an agent-native, self-hostable issue tracker with a complete REST API (`/v1/*`), an OAuth 2.1 authorization server built for MCP clients, and an OpenAPI document at `/v1/openapi.json`. This plan adds a first-party iOS client: a SwiftUI app that treats the API as its sole backend, signs in with the same OAuth flow Claude Desktop/Cursor use, and reaches full board parity before its first TestFlight build.

### Problem Frame

The user holds an Apple Developer membership ($99/yr) and wants Tallyline on iOS — explicitly "doesn't have to be soon," i.e. a roadmap-tracked feature, not an urgent build. Today the only clients are the Next.js web app, the CLI, and MCP agents; none are usable on a phone. The OAuth infrastructure, consent screen, and public-client PKCE flow already exist for MCP — the iOS app reuses them rather than inventing a second auth scheme.

### Requirements

- **R1 — Instance selection.** First launch offers an instance URL field defaulting to `https://api.tallyline.app`; the chosen URL drives OAuth issuer discovery and all API calls, so self-hosted instances work without an app update.
- **R2 — OAuth sign-in.** Sign-in runs ASWebAuthSession against the instance's `/oauth/authorize` with S256 PKCE; the app registers itself via RFC 7591 DCR on first use (public client, `token_endpoint_auth_method: none`). A `tallyline://` custom-scheme redirect completes the callback.
- **R3 — Token lifecycle.** Access + refresh tokens live in the iOS Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, no iCloud sync). 401 → single-flight refresh → retry once; refresh failure → sign-out to the instance picker.
- **R4 — Workspace context.** After sign-in the app loads `/v1/whoami`, lists workspaces, and persists the active workspace slug; a workspace switcher re-scopes every request (`/v1/workspaces/{slug}/...`).
- **R5 — Issue loop.** My-issues and triage queues, issue list with state/assignee/label filters, issue detail (description, comments, sub-issues, activity), create/edit issue, post comments, change state/assignee/priority/labels — matching web behavior through the same endpoints.
- **R6 — Board parity.** Projects list/detail, cycles (active, upcoming, complete), labels, and the roadmap view — all readable; create/edit where the API supports it.
- **R7 — Keyboard-first ethos on iPad.** Where a hardware keyboard is present, discoverable shortcuts (Cmd+K command palette, j/k navigation) mirroring the web ethos. iPhone remains fully touch-driven.
- **R8 — Design fidelity.** Silver Lining tokens (color, type scale, spacing, radii) drive the SwiftUI theme so the app reads as Tallyline, not stock iOS — dark and light.
- **R9 — Tester distribution.** Signed builds installable on registered devices via `xtool install` — that alone satisfies v1. A TestFlight build upload (Build Uploads API) is attempted in U8 but is non-blocking; no App Store submission in v1.
- **R10 — Redirect-URI validation.** The API accepts RFC 8252 §7.1 private-use URI schemes (e.g. `tallyline://oauth/callback`) during DCR for native clients, while continuing to reject non-https, non-loopback http, and fragment-bearing URIs.

### Key Decisions

- **Full board parity in v1** (`session-settled: user 2026-10-12`) — chosen over a triage-only companion or agent-approval app; the API surface is already complete, so parity is a client-side build problem, not a backend one. Governs R5, R6.
- **OAuth browser flow, not PAT** (`session-settled: user 2026-10-12`) — ASWebAuthSession + PKCE reuses the OAuth 2.1 server built for MCP clients; no credential paste, refresh tokens handled server-side, self-host-ready via instance URL. Governs R1, R2, R3.
- **Native SwiftUI, not RN/PWA** (`session-settled: user 2026-10-12`) — best fit for iOS polish, Keychain, ASWebAuthSession, widgets/Shortcuts headroom, and the keyboard-first design ethos; accepts that no web UI code is shared. Governs R7, R8.
- **Beta distribution, not App Store** (`session-settled: user 2026-10-12`, refined during planning) — user picked TestFlight; xtool's local install path covers the same dogfood need without an upload mechanism, so v1's bar is registered-device installs with TestFlight as the stretch. App Store review, screenshots, privacy manifest deferred. Governs R9.
- **App lives in the monorepo** — `apps/ios` keeps one issue tracker, one DESIGN contract, and silver-lining tokens in reach; the Xcode project does not join the pnpm workspace. Governs U2.

### Success Criteria

- A tester can install the app on their registered device (via xtool, or TestFlight if the U8 spike lands), point it at `api.tallyline.app` (or a self-host URL), sign in through the OAuth consent screen without typing a password into the app, and work their board end to end.
- Every screen the web board exposes for read operations has an iOS equivalent backed by the same `/v1` endpoints.
- Sign-in survives days of use (refresh path) and fails closed (revoked token → signed-out picker, no crash, no stale session).

### Scope Boundaries

**Deferred for later:** APNs push notifications, universal-link (AASA) OAuth callback, iPad/macOS-Catalyst-specific layouts beyond adaptive defaults, home-screen widgets, Siri/Shortcuts intents, share extension, offline write queue, App Store submission, Android.

**Outside this product's identity:** editing Silver Lining tokens for iOS's sake; a second backend; agent-dispatch UX beyond reading dispatch state the API already returns.

### Open Questions

- **Bundle/App ID naming**: `app.tallyline.ios` vs `app.tallyline.mobile` — decide at U2; must match the AASA domain later.
- **TestFlight upload mechanism** (deferred to U8): xtool builds/signs/installs locally but has no App Store Connect upload subcommand — the upload path is the Build Uploads API: create a `buildUploads` resource, transfer the binary via `buildUploadFiles` + its `uploadOperations`, both callable from Linux with an ASC API key. Direct device install via `xtool install` already covers dogfooding, so v1 is not blocked on this.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — API is frozen for v1 except one validation change.** Board parity maps onto existing `/v1` routes; the only server change is R10 (private-use redirect schemes in DCR validation at `apps/api/src/services/mcp-oauth.ts` — `validRedirectUri`/`validateRedirectList`). No new endpoints, no token-shape changes.
- **KTD2 — DCR-first client identity.** The app calls `POST /oauth/register` once per instance (client_name `Tallyline iOS`, redirect `tallyline://oauth/callback`, `token_endpoint_auth_method: none`), persists `client_id` per instance URL in Keychain, then runs standard auth-code+PKCE. Issuer discovery via `/.well-known/oauth-authorization-server` (already served). Universal-link callback is the post-v1 upgrade — requires `apple-app-site-association` hosting + associated-domains entitlement; custom scheme is sufficient for TestFlight.
- **KTD3 — Generated API client.** `swift-openapi-generator` (Apple's official package) consumes `/v1/openapi.json` at build time into `Sources/Generated`; middleware injects the bearer token and workspace slug. A `scripts/gen-api-client.sh` pins the spec fetch so regeneration is reproducible. Fallback: hand-rolled `APIClient` + Codable models if generated types fight SwiftUI — decide in U4 with one spike day.
- **KTD4 — Single-target SwiftUI app as an xtool SwiftPM project, zero UI deps.** `xtool new` scaffold (`Package.swift` + `xtool.yml`), not an `.xcodeproj` — xtool builds SwiftPM packages directly on Linux. `NavigationStack` on iPhone, `NavigationSplitView` on iPad; async/await + `ObservableObject` view models; Keychain via `Security` framework behind a `TokenStore` protocol for testability. Only package dep: `swift-openapi-generator` + its `OpenAPIURLSession` runtime (must resolve under the open-source Swift toolchain — verify in the U2 spike).
- **KTD5 — Token theme, not a port.** Silver Lining tokens are source-generated: a small `packages/silver-lining` build step already emits JSON — the app consumes a generated `Theme.swift` (color/type/spacing constants), keeping design drift one regen away.
- **KTD6 — xtool owns build, sign, and install locally.** `xtool ds` manages the paid-account certificate/profile/device lifecycle (1-year provisioning, no 7-day expiry); `xtool dev build` produces signed IPAs; `xtool install` sideloads to registered devices — that IS the v1 dogfood path, proven locally by `kate-ios`. TestFlight upload is the one gap (see Open Questions) and is a scripted ASC API call, not a build-system dependency.

### High-Level Technical Design

```
iPhone/iPad                     instance (api.tallyline.app or self-host)
┌──────────────┐    DCR once    ┌──────────────────────────┐
│ Tallyline iOS│ ─────────────▶ │ POST /oauth/register     │
│              │   ASWebAuth    │ GET /oauth/authorize     │
│  TokenStore  │ ◀────────────▶ │ POST /oauth/token (PKCE) │
│  (Keychain)  │   refresh      │                          │
│  APIClient   │ ─────────────▶ │ /v1/workspaces/{slug}/*  │
│  (generated) │  bearer        │ issues·projects·cycles…  │
└──────────────┘                └──────────────────────────┘
```

### Assumptions

- The OAuth server stays public-client-only; no client secrets ship in the app.
- `/v1/openapi.json` remains current enough to generate against (it requires auth today — U4 fetches with a dev token or unauthenticated copy task decides).
- APNs is out of v1 scope per scope boundaries; the app polls.
- **xtool is the build toolchain** — installed locally (v1.21.0) and already proven against the user's paid developer account by the `kate-ios` app. No macOS/XCode access needed or assumed.

### Sequencing

U1 (API redirect schemes) → U2 (scaffold) → U3 (auth) → U4 (client) → U5 (issue loop) → U6 (board parity) → U7 (theme/keyboard) → U8 (distribution). U1 is independent and deploys alone; U5/U6 can overlap if multiple hands exist.

---

## Implementation Units

### U1. API: allow native-app redirect schemes

- **Goal:** iOS (and any future native client) can complete DCR with a private-use URI scheme.
- **Requirements:** R10
- **Files:** `apps/api/src/services/mcp-oauth.ts` (`validRedirectUri`, `validateRedirectList`), `apps/api/src/routes/mcp-oauth.test.ts`
- **Approach:** Extend `validRedirectUri` to accept absolute URIs whose scheme is `[a-z][a-z0-9+.-]*`, is not `http`/`https`/`javascript`/`data`/`file`, and has no fragment — per RFC 8252 §7.1. Keep the existing https + http-loopback paths and the fragment ban. Emit a CHANGELOG note: DCR now accepts custom schemes.
- **Test scenarios:** `tallyline://oauth/callback` registers; `com.example.app:/cb` registers; `javascript:alert(1)`, `data:text/html,x`, `http://evil.com`, `https://x#frag` still rejected; loopback port-flex rule still passes (regression).
- **Verification:** `pnpm --filter @tallyline/api test` green.

### U2. xtool scaffold + repo home

- **Goal:** `apps/ios` contains a buildable SwiftUI app package + test target, bundle ID reserved via the developer account.
- **Requirements:** R1 (scaffold only), KTD1, KTD4, KTD6
- **Files:** `apps/ios/**` (new), `apps/ios/README.md` (xtool build/test/signing notes), repo `README.md` one-line mention
- **Approach:** `xtool new` produces a SwiftPM app project (`Package.swift` + `xtool.yml` + `Sources/`); min iOS 17, Swift 6 strict concurrency, `Tallyline` target + `TallylineTests`. Register the App ID + provisioning profile with `xtool ds identifiers` / `xtool ds profiles` against the paid account; entitlements minimal for v1 (no APNs, no associated domains until universal links land). Add the `swift-openapi-generator`/`OpenAPIURLSession` package deps here and confirm they resolve under xtool's Darwin Swift SDK — that is this unit's spike; if resolution fails, fall back to hand-rolled Codable models and drop the dep. Gitignore `.xtool`, `Packages/`, build output.
- **Test scenarios:** `xtool dev build` produces a signed IPA on this machine; `swift test` (host-side logic tests) passes on a clean checkout.
- **Verification:** signed IPA installs to a registered device via `xtool install` and launches to the instance picker; no secrets committed.

### U3. Auth: instance picker → OAuth → Keychain

- **Goal:** R1–R4 implemented end to end — a user lands signed-in with a workspace selected.
- **Requirements:** R1, R2, R3, R4
- **Files:** `apps/ios/Sources/Auth/*`, `apps/ios/Sources/InstancePickerView.swift`, `apps/ios/Sources/TokenStore.swift`, `apps/ios/TallylineTests/AuthTests.swift`
- **Approach:** `TokenStore` protocol → `KeychainTokenStore` (per-instance `client_id`, access/refresh tokens). `AuthCoordinator` drives DCR → ASWebAuthSession(`/oauth/authorize?…&code_challenge=…`) → `tallyline://oauth/callback` interception → `POST /oauth/token`. Refresh single-flighted behind an `actor`; on `invalid_grant` wipe tokens → picker. After token: `GET /v1/whoami` → workspace list → persist choice. Mock `URLProtocol` tests for the whole dance.
- **Test scenarios:** happy-path sign-in against a stub issuer; refresh path on 401; refresh failure signs out; instance URL `https://selfhost.example` flows through registration; `tallyline://` callback URL parses code/state correctly; state/nonce mismatch rejected.
- **Verification:** XCTest green; manual sign-in against `api.tallyline.app` completes through the live consent screen.

### U4. Generated API client

- **Goal:** Typed client for all `/v1` workspace routes consumed by every screen.
- **Requirements:** R5, R6 enabling layer; KTD3
- **Files:** `apps/ios/Sources/Generated/*` (gitignored output or vendored — decide in unit), `apps/ios/scripts/gen-api-client.sh`, `apps/ios/Sources/APIClient/*`
- **Approach:** Fetch `openapi.json` (dev-token fetch documented in script; alternatively vendor a checked-in spec snapshot + regen step). Configure generator `types` + `client` outputs, `OpenAPIURLSession` transport, bearer-injecting `ClientMiddleware`, workspace-slug path param from `SessionStore`. Wrap pagination (`nextCursor`) behind `AsyncSequence`. One spike day; if generator output is unworkable, hand-roll Codable models for the ~8 resources instead and record the deviation.
- **Test scenarios:** decode fixtures for issue/project/cycle/comment payloads (sampled from API tests); cursor pagination iterates 2 pages; 401 flows to TokenStore, 429/5xx surface typed errors.
- **Verification:** generated client compiles; fixture tests green.

### U5. Issue loop screens

- **Goal:** The daily-driver surface — triage, my-issues, detail, comment, edit.
- **Requirements:** R5, R4
- **Files:** `apps/ios/Sources/Issues/*` (lists, detail, composer, filters), `apps/ios/TallylineTests/IssueViewModelTests.swift`
- **Approach:** Lists = `List` + searchable + state/assignee/label filter bar; pull-to-refresh; detail shows description, comment thread (post field), sub-issues, activity/events, edit sheet for title/state/assignee/priority/labels/cycle/project; create sheet from the tab bar. All mutations through the generated client; optimistic state change with revert on failure.
- **Test scenarios:** view-model tests — state transition calls PATCH, comment posts and appends, optimistic revert on 500, filter composition builds the right query params; UI smoke: list renders fixture data.
- **Verification:** manual pass — triage a real issue, comment, move to done, watch it land on web.

### U6. Board parity views

- **Goal:** Projects, cycles, labels, roadmap — full R6.
- **Requirements:** R6
- **Files:** `apps/ios/Sources/Projects/*`, `apps/ios/Sources/Cycles/*`, `apps/ios/Sources/Roadmap/*`, `apps/ios/TallylineTests/BoardViewModelTests.swift`
- **Approach:** Tab or sidebar sections mirroring web: Projects (list → detail board), Cycles (active/upcoming/past, per-team), Labels (list, edit), Roadmap (projects on a timeline). Read-first; create/edit only where `/v1` supports it — no invented endpoints.
- **Test scenarios:** fixture-render each section; cycle grouping matches `?active=true` semantics; roadmap ordering matches web sort.
- **Verification:** screen-by-screen parity checklist against the web app.

### U7. Silver Lining theme + keyboard

- **Goal:** The app looks like Tallyline and honors R7.
- **Requirements:** R7, R8
- **Files:** `packages/silver-lining` (add `ios` emit target — `Theme.swift` codegen), `apps/ios/Sources/Theme/*`, keyboard shortcut modifiers across screens
- **Approach:** Extend the silver-lining build to emit Swift constants (color RGBA, type scale pt, spacing, radii) alongside existing CSS/JSON/TS outputs; `Theme` namespace + `Color`/`Font` extensions in the app; dark/light via asset variants generated from both modes. Keyboard: `commands` modifier — Cmd+K palette (jump to issue/screen), j/k list nav, enter open, on iPad/hardware keyboard.
- **Test scenarios:** token regen produces compilable Swift; snapshot-ish assertions on resolved colors in both schemes; Cmd+K opens palette in UI test.
- **Verification:** `pnpm --filter @tallyline/silver-lining build` emits `Theme.swift`; visual pass vs web.

### U8. Distribution: device install now, TestFlight spike

- **Goal:** The app is running on real devices via xtool; the TestFlight upload path is proven or explicitly deferred.
- **Requirements:** R9, KTD6
- **Files:** `apps/ios/README.md` distribution section, `apps/ios/scripts/` (sign/build/install + optional ASC upload script), `ROADMAP.md` (row update)
- **Approach:** Repeatable local pipeline: `xtool ds` (cert/profile/device) → `xtool dev build` (release IPA) → `xtool install` to registered devices — this satisfies dogfood distribution under the paid account (1-year provisioning). Two distinct artifacts: the **dev-signed IPA** (development cert + development profile) for device installs, and — only if TestFlight lands — a **distribution-signed IPA** (Apple Distribution cert + App Store provisioning profile for the same App ID). TestFlight spike: create the app record in App Store Connect, mint an ASC API key, upload the distribution IPA via the Build Uploads API (`buildUploads` + `buildUploadFiles`). If the spike fails, dev-signed installs are v1 distribution and App Store/TestFlight is recorded as a deferred follow-up — not a blocker.
- **Test scenarios:** release IPA signs + installs cleanly on a second registered device; provisioning profile renewals documented; TestFlight spike outcome recorded either way.
- **Verification:** a second device runs the app signed from this machine; TestFlight status documented (uploaded or deferred).

---

## Verification Contract

- API change: `pnpm --filter @tallyline/api test` (mcp-oauth tests must stay green including new scheme cases); `pnpm check` repo-wide for U1's PR.
- iOS: `xtool dev build` produces a signed IPA per unit; `swift test` keeps `TallylineTests` green; `xtool install` + launch on a registered device is the per-unit smoke gate.
- Live acceptance: sign-in → triage → comment → state change → verify on web, against `api.tallyline.app`.
- Distribution: dev-signed install on a second device; TestFlight upload proven or explicitly deferred per U8.

## Definition of Done

- U1 merged and deployed (custom schemes registerable).
- `apps/ios` on `main`; `xtool dev build` produces a signed IPA, tests green.
- Tester signs in via OAuth consent (no password-in-app), works the full board, stays signed in across refresh cycles.
- App installed on ≥1 registered device via xtool; TestFlight upload outcome recorded (uploaded or deferred).
- `ROADMAP.md` U15 row points at this plan; any abandoned spike code removed from the diff.
- App Store submission remains explicitly out — noted in ROADMAP.
