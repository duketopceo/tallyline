---
title: iOS and iPadOS — the one UI/UX plan (shell, motion, projects, roadmap, detail, composer, settings)
created: 2026-11-03
updated: 2026-11-03
status: draft
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
supersedes: the earlier draft of this file (projects/roadmap only); the "Native shell" unit of the same; the iOS shell portion of #231 U7
---

# iOS and iPadOS: the one UI/UX plan

## Goal Capsule

Make the Tallyline iPhone and iPad app feel like a first-party iOS 26 app
that happens to be about agents. One plan owns every visible surface: the
shell, motion, rows, projects, roadmap, issue detail, the composer, offline
state, and a complete settings area. Nothing visual is specified anywhere
else; #231 keeps the public-intake backend and web helpdesk, and its iOS
unit (U7) becomes the "Now" feed described here.

## What exists today (verified 2026-11-03 against `main` @ `63875a1`)

- `apps/ios/Package.swift` targets **iOS 17**. No `#available` gates anywhere.
- `HomeView` (`BoardViews.swift`) switches on `horizontalSizeClass`:
  `TabView` on iPhone, `NavigationSplitView` with a `List` sidebar on iPad.
  Sections: Triage, Issues, Review, **Settings** (a tab). Command-1…4,
  Command-R, Command-N exist. Deep links route through `AppRouter`.
- `IssueRow`: monospaced key, optional `Glint`, `×N`, priority as **text**,
  title (2 lines), state as text. No glyphs, swipe actions, or context menu.
- `IssueDetailView`: `List` with inline `Picker`s (each pushes a screen),
  Approve / Send back as list buttons, comment `TextField` inside the list so
  it scrolls under the keyboard.
- `CreateIssueView`: `Form` — Title, Description, Team, Priority.
  `IssueCreate` carries only `title, description, teamId, priority`.
- `SettingsView`: Workspace, Appearance (system/light/dark), Notifications,
  Sync → `OutboxView`, You, Sign out. Outbox is the only place pending
  writes are visible.
- `TrackerClient`: `issues, issue, createIssue, updateIssue, comments,
  addComment, reviewIssue, projects, cycles, labels, teams, members, agents,
  reviewQueue`. `Project` decodes only `id, name, description, status`;
  `Cycle` has no counts; nothing decodes milestones.
- API already serves: `GET /v1/workspaces/:ws/roadmap/summary` →
  `totals, projects[] (projectId,total,done,closed,inProgress,inReview),
  milestones[] (milestoneId,total,done), merges[], doneSince`;
  `GET /v1/workspaces/:ws/milestones`; `/projects, /cycles, /labels,
  /members, /agents`. **No owner, lead, or health fields exist.** Do not plan
  around them.
- `TallylineDesign/Theme.swift`: Silver Lining tokens (light / dark /
  high-contrast dark), radius scale 4–14, `Theme.glint`, `GlintShape`. No
  shared row, pill, glyph, or ring components.
- Accessibility rotors ("Urgent and high", "Agent work") and `IssueSpeech`
  exist on the issue list. `Haptics` seam exists.
- `OfflineModel`: optimistic `applyLocally`, `submit` → `.sent / .queued /
  .rejected`, entries with `.pending(attempts)` / `.failed(reason)`.

## Design bar

Grounded in Apple's iOS 26 / iPadOS 26 guidance. Linear Mobile was the
earlier reference; it is dropped. Copying it yields a Linear clone with
fewer features, and that is not unique.

1. **Native controls carry the glass.** Tab bar, toolbars, sheets, search,
   menus adopt Liquid Glass when built against the iOS 26 SDK. Content stays
   on solid Silver Lining surfaces. No `glassEffect` in content views.
2. **Tab bar is navigation.** Settings leaves the bar. Search is the trailing
   search-role tab. Badge only on Review.
3. **Concentric geometry.** `ConcentricRectangle` on iOS 26 for nested pills
   and sheet corners; radius scale below 26. Nothing above 14.
4. **Colour means state.** Accent for the one primary action. Status colours
   for state glyphs and rings. Glint for agents. Nothing else is tinted.
5. **Motion has a grammar** (see "Motion system"). Three durations, two
   springs, one hero transition, one symbol effect per meaning. Reduce
   Motion collapses every one to a crossfade.
6. **One signature: the agent pulse.** A read-only strip attached to the tab
   bar — "2 agents working · 3 in review · 1 waiting to send". Recognisable
   in any screenshot.
7. **iPad is a layout, not a stretched phone.** Top tab bar → sidebar,
   two-column browsing, inspector for properties, pointer hover, keyboard.
8. **Accessibility is a gate.** Reduce Transparency, Increase Contrast,
   Reduce Motion, AX5 Dynamic Type, one-sentence VoiceOver rows — all are
   acceptance criteria.

## Motion system

Defined once in `TallylineDesign/Motion.swift`; views never write raw
`.easeInOut(duration:)`.

| Token | Value | Used for |
|---|---|---|
| `Motion.quick` | `.snappy(duration: 0.18)` | pill selection, toggle, badge count |
| `Motion.standard` | `.smooth(duration: 0.28)` | list insert/remove, state glyph change, sheet detents |
| `Motion.hero` | `.spring(response: 0.42, dampingFraction: 0.86)` | zoom navigation, ring fill on appear |
| `Motion.ambient` | `.easeInOut(duration: 1.6).repeatForever` | pulse Glint only, off under Reduce Motion |

Rules:

- **Hero transitions.** Row → detail and pill → picker use
  `matchedTransitionSource` + `.navigationTransition(.zoom(sourceID:in:))`
  (iOS 18+). On iOS 26 sheets morph from the toolbar button that presents
  them. One namespace per `NavigationStack`.
- **Content transitions.** Counts use `.contentTransition(.numericText())`;
  state glyphs use `.contentTransition(.symbolEffect(.replace.downUp))`.
- **Symbol effects, one per meaning.** Review approved → `.bounce`; outbox
  sent → `.disappear`; agent active → `.pulse` on the Glint (ambient; static
  under Reduce Motion); error → `.wiggle` (iOS 18+).
- **Choreographed sequences** use `phaseAnimator` (sequential) or
  `keyframeAnimator` (parallel tracks). Only three are allowed: progress ring
  fill on first appear, review-decision confirmation, pulse strip state
  change. Anything else is a scope question.
- **Scroll.** Roadmap bars and project cards use `.scrollTransition` for
  opacity/scale at the edges only; rows in plain lists do not.
- **Haptics via `.sensoryFeedback`**, mapped: `.success` on approve/create,
  `.warning` on reject/outbox fail, `.selection` on pill pick,
  `.impact(.light)` on swipe-action commit. No haptic on navigation.
- **Reduce Motion.** `@Environment(\.accessibilityReduceMotion)` is read in
  `Motion`; every token resolves to `.linear(duration: 0.12)` opacity-only
  and the ambient token to `nil`.

## Product Contract

### Requirements

R1. One shell declaration (`Tab` + `.sidebarAdaptable`) serves iPhone and iPad; Settings is a toolbar sheet, not a tab.
R2. Every row shows a state glyph, a priority glyph, key, title, one metadata line, swipe actions, and a context menu.
R3. Projects and roadmap are visible on the phone using only fields the API returns; counts come from `/roadmap/summary`, never client guesses; a project absent from the summary renders as zero.
R4. Issue detail edits state, priority, team, project, cycle, labels, and agent from inline pills opening detent sheets.
R5. The comment composer stays pinned above the keyboard.
R6. The create composer is title-first, exposes the same pills, and queues offline with every selected property preserved through the outbox.
R7. Settings is grouped into Account, Appearance, Notifications, Sync, Agents, About, Sign out — each a native control — and outbox state is visible from the shell.
R8. iPad browses list → detail in two columns; selection survives rotation and Stage Manager resizes.
R9. Motion follows the motion system; Reduce Motion collapses all of it.
R10. Reduce Transparency, Increase Contrast, AX5, and VoiceOver one-sentence rows pass on every surface.
R11. Offline semantics in `OfflineModel` are unchanged.

### Scope Boundaries

In: deployment floor, shell, motion system, shared components, rows, projects, roadmap, "Now" feed root, issue detail, composer, settings, pulse strip, iPad, Liquid Glass adoption, accessibility gate, `IssueCreate` widening, `Project`/`RoadmapSummary`/`Milestone` decoding.

Out: public intake backend, web helpdesk, `SECRETS_KEY_MISSING` surfacing (#231 U1–U6, U8); rich-text comments; Sign in with Apple; widgets reading roadmap data; release pipelines; any API change beyond widening `IssueCreate`.

### Key Decisions

- **Deployment floor → iOS 18.** `Tab`, `sidebarAdaptable`, zoom transitions, `.wiggle` need it. iOS 26 APIs (Liquid Glass, `tabViewBottomAccessory`, `ConcentricRectangle`, `tabBarMinimizeBehavior`, `backgroundExtensionEffect`) sit behind `#available(iOS 26, *)` with a tested fallback. Luke confirms; default is 18.
- **Root = Now, not Issues.** The first tab is a chronological feed of agent actions and review requests. Issues is a tab, not the root. This absorbs #231 U7.
- **Only API-backed fields.** No owner avatar, lead, or health ring until an API contract exists. Progress rings are summary-count rings.
- **Components live in `TallylineDesign`.** `StateGlyph`, `PriorityGlyph`, `PropertyPill`, `ProgressRing`, `IssueRowView`, `PulseBar`, `Motion`. App views compose; they do not restyle.
- **No custom glass** in any content view. Enforced by lint in U12.
- **Outbox state mapping is explicit.** Shell shows `pending` (attempts == 0), `retrying` (attempts > 0, not failed), `parked` (`.failed`). No new persisted state.

## Implementation Units

Each unit is one work order (`labels: work-order`). U1 and U2 gate the rest.

### U1 — Floor, shell, search tab, settings out of the bar

`Package.swift`; `BoardViews.swift` → `Shell/ShellView.swift`.

- `platforms: [.iOS(.v18), .macOS(.v14)]`.
- `TabView { Tab("Now"...) Tab("Issues"...) Tab("Projects"...) Tab("Review"...) Tab(role: .search) }`
  `.tabViewStyle(.sidebarAdaptable)`; iOS 26: `.tabBarMinimizeBehavior(.onScrollDown)`.
  Roadmap is reached from Projects (segmented `Projects | Roadmap` at the top of that tab), not a fifth tab.
- Review `.badge(reviewCount)`; zero hides it.
- Settings: `ToolbarItem(placement: .topBarTrailing)` initials button on every
  tab → `SettingsView` sheet. Command-, opens it. Command-1…4 map to the four
  content tabs; Command-R and Command-N unchanged.
- `AppRouter` gains `.now, .projects, .project(id), .roadmap, .settings`.
  `tallyline://open/...` adds `/projects`, `/roadmap`.
- Each tab owns a `NavigationStack`; roots use large titles.

Acceptance: one declaration serves both devices; iPad shows the top tab bar
with sidebar toggle; Settings is not in the bar; a cold launch from a push
deep link lands on the right tab with a back stack; every shortcut appears
in the Command-key overlay.

### U2 — Core: roadmap summary, milestones, wider models, wider create

`TallylineCore/TrackerClient.swift`, `TrackerModels.swift`,
`OfflineModel.swift`, `Tests/TallylineCoreTests/Fixtures`.

- Decode `RoadmapSummary` (`totals, projects, milestones, merges, doneSince`);
  add `roadmapSummary(ws:since:)`, `milestones(ws:)`.
- Widen `Project` to exactly the columns `GET /projects` returns today
  (list them in the PR from the route handler), all new fields optional.
- Widen `IssueCreate` and `IssuePatch` with optional `assigneeType`,
  `assigneeId`, `labelIds`, `projectId`, `cycleId`; carry them through
  `OutboxOperation.createIssue` / `.updateIssue` serialisation and replay.
- Expose `OfflineModel.lastSyncedAt`, `isDraining`, and a derived
  `displayState(for:)` → `pending | retrying | parked`.
- Fixtures extended from `ios-contract.test.ts`; decode tests for the new
  types; round-trip tests for every optional create/patch field.

Acceptance: `TALLYLINE_CORE_ONLY=1 swift test` passes on Linux;
`ios-contract.test.ts` still fails on shape drift; no field is `Any`-typed
to hide a missing column.

### U3 — Design components and motion tokens

`TallylineDesign/Motion.swift`, `Components/StateGlyph.swift`,
`PriorityGlyph.swift`, `PropertyPill.swift`, `ProgressRing.swift`,
`IssueRowView.swift`, `PulseBar.swift`, `Density.swift`.

- `StateGlyph(state:)` — one filled SF Symbol per `IssueState`, status
  colour per `DESIGN.md`, `@ScaledMetric(relativeTo: .body)`.
- `PriorityGlyph(priority:)` — three ascending bars drawn with `Path`.
- `PropertyPill(title:systemImage:tint:)` — capsule, `ConcentricRectangle`
  on 26, `radiusMd` below; `.hoverEffect(.highlight)`.
- `ProgressRing(done:total:)` — summary counts only; `keyframeAnimator` fill
  on first appear under `Motion.hero`; static under Reduce Motion;
  `.contentTransition(.numericText())` on the centre label.
- `IssueRowView` — `[StateGlyph] [key · title (2 lines)] / [PriorityGlyph · Glint? · ×N · relative time]`.
  Single `accessibilityElement(children: .ignore)` using `IssueSpeech`.
- `PulseBar` — read-only one-liner; see U9.
- `Density` environment key (`comfortable | compact`) read by rows and pills.
- Snapshot previews for every component at Default and AX5.

Acceptance: components build in the `TallylineKit` product for extensions;
no component imports app code; previews render in both densities.

### U4 — Rows, lists, swipe, context menu

`Browse/IssueListView.swift`, `Browse/ReviewQueueView.swift`.

- Replace `IssueRow`/`ReviewRow` with `IssueRowView`. Sectioned by state with
  `.footnote.smallCaps()` headers when the list is unfiltered.
- `.swipeActions(edge: .leading)`: valid forward state transitions.
  `.swipeActions(edge: .trailing)`: Assign to me.
  `.contextMenu`: Copy key, Copy link, Assign to me, Change state ▸.
- All mutations go through `OfflineModel.submit` with optimistic
  `applyLocally` and rollback on `.rejected`; `Motion.standard` on row moves.
- Rotors kept and extended: "In review", "Blocked".

Acceptance: a row never exceeds three text lines at default size; swipe
state changes roll back on `.rejected`; VoiceOver reads a row as one
sentence including state and agent; AX5 snapshot shows no clipped glyphs.

### U5 — Now feed (root)

`Now/NowView.swift`, `Now/NowModel.swift`.

- Chronological feed: agent actions (from `/roadmap/summary` `merges` and
  agent surfaces), review requests (`reviewQueue`), parked outbox writes.
  One sentence per row: actor, verb, issue key, relative time. Glint on
  agent rows.
- Grouped Today / Yesterday / Earlier. Pull to refresh; `.task` on appear.
- Tap → issue detail via zoom transition. Empty state:
  `ContentUnavailableView("Quiet", systemImage: "moon.zzz")`.
- Every row carries an "as of" time when its source is older than 5 min.

Acceptance: feed ordering is deterministic (test on `NowModel`); stale data
is marked; a parked write appears at the top with a `tray.and.arrow.up`
glyph; no network call fires that the issue sync does not already make.

### U6 — Projects and roadmap

`Projects/ProjectListView.swift`, `ProjectDetailView.swift`,
`Roadmap/RoadmapView.swift`.

- Projects list: name, status chip, `ProgressRing` from summary counts
  (missing summary row → 0/0 ring, not hidden), target date if the column
  exists. Sorted status → target date. `.searchable`, `.refreshable`,
  empty state offering Create project.
- Project detail: header ring + counts; issues for that project grouped by
  state using `IssueRowView`; zoom transition into detail.
- Roadmap: horizontal month grid, lanes for cycles and milestones, each bar a
  summary-count ring; sticky month header, snapping scroll, today marker;
  `.scrollTransition` fades bars at the edges; Reduce Motion snaps without
  animation. Tap → project or milestone detail.
- Segmented `Projects | Roadmap` control at the top of the tab.

Acceptance: counts equal `/roadmap/summary` exactly; a workspace with no
milestones shows an empty state, not a blank canvas; the today marker sits
on the correct month for the device timezone; a project with zero issues
still renders.

### U7 — Issue detail

`Detail/IssueDetailView.swift`, `Detail/PropertySheet.swift`.

- Header: key, title (`.title3.semibold`), description with
  `.textSelection(.enabled)`.
- Pill row: State, Priority, Team, Project, Cycle, Labels, Agent/Assignee.
  Tap → sheet with `.presentationDetents([.medium, .large])`, zoom from the
  pill. Selection commits through `IssuePatch` with optimistic update.
- Approve as `.confirmationAction` toolbar item; Send back in a trailing
  `Menu` with `role: .destructive`. `.sensoryFeedback(.success/.warning)`.
- Comments as a `ScrollView` thread; agent author lines carry the Glint.
- Composer in `.safeAreaInset(edge: .bottom)`: vertical `TextField` 1…5
  lines, Send, plus `ToolbarItemGroup(placement: .keyboard)` with Agent and
  Label. Command-Return posts.
- `pendingNote` / `actionError` as a status line above the composer.

Acceptance: changing state from a pill updates the originating list without
reload; composer visible with keyboard up on the smallest supported iPhone;
Approve reachable without scrolling; pickers restore scroll position.

### U8 — Create composer

`Compose/CreateIssueView.swift`.

- Title first and focused; pill row (Team, Priority, Project, Labels, Agent);
  Description last.
- Keyboard accessory: Agent, Label, Priority quick-pick.
- `TeamMemory` unchanged. `.queued` shows a pending capsule and the pulse
  updates.

Acceptance: airplane-mode create parks with all selected properties intact
(round-trip test from U2); assigning an agent never leaves the sheet.

### U9 — Agent pulse and offline surfacing

`Shell/PulseBar.swift` wiring, `SessionModel.swift`.

- Text: `[Glint] 2 agents working · 3 in review · 1 waiting to send`; only
  non-zero segments; all-zero → `Up to date`; offline → `wifi.slash Offline ·`.
- iOS 26: `.tabViewBottomAccessory { PulseBar() }`; below: `.safeAreaInset`.
- Tap → Review if count > 0, else Outbox sheet.
- Data from the existing sync cycle; no separate timer. "As of" suffix when
  older than 5 min. Glint `.pulse` only while agents are active and Reduce
  Motion is off.

Acceptance: airplane mode flips the strip within one sync cycle; a parked
write is visible on every tab; VoiceOver reads the strip as one sentence.

### U10 — Settings (comprehensive)

`Settings/SettingsView.swift`, `AccountView.swift`, `AppearanceView.swift`,
`NotificationsView.swift`, `SyncView.swift`, `AgentsView.swift`,
`AboutView.swift`, `DiagnosticsView.swift`.

Presented as a sheet from the shell initials button. `Form`,
`.formStyle(.grouped)`, native controls only.

**Account**
- Name and avatar initials (whoami), workspace name, server host.
- Credential: expires (relative), "renews automatically" hint, **Renew now**.
- **Switch workspace** → `InstancePickerView`. **Paired devices** (read-only
  list from the API if exposed; otherwise this device only).

**Appearance**
- Theme: System / Light / Dark.
- App icon: Default / Dark / Tinted / Mono via `setAlternateIconName`
  (artwork blocked on Luke).
- Density: Comfortable / Compact (drives `Density`).
- Accent for agent glint: Default / Reduced (grey Glint for colour-sensitive
  users). Nothing else is user-tintable.
- Motion: follows system; **Reduce app motion** override; **Pulse animation**
  toggle.
- Row preview that live-updates with the choices above.

**Notifications**
- System authorisation status with **Open Settings** link when denied.
- Per-event toggles: Review requested, Agent finished, Mentioned, Assigned,
  Outbox parked. Quiet hours (start/end) if the push relay supports it;
  otherwise hidden.
- **Send test notification**.

**Sync**
- Outbox row with status pill (`All sent` / `N waiting` / `N need you` in
  `Theme.urgent`) → `OutboxView` with `pending | retrying | parked` labels,
  Retry all, Discard parked.
- Last synced (relative), **Sync now**.
- Cache: size, **Clear cached issues**; Sync on cellular toggle.

**Agents**
- List from `agents(ws:)`: name, status, last active. Tap → recent activity
  (reuses `NowModel` filtered). Default agent for new issues picker.

**About**
- Version and build, server version (from health/whoami), licences
  (AGPL-3.0 app, MIT MCP/CLI), privacy policy, source link.
- **Diagnostics**: copy a redacted bundle (device, OS, app build, server
  host, outbox counts, last sync) to the pasteboard; **Share logs**.

**Sign out**
- Destructive, `confirmationDialog`, unregisters push first (as today).

Acceptance: every row is `LabeledContent`, `Toggle`, `Picker`, `Stepper`,
`NavigationLink`, or `Button`; no custom chrome; VoiceOver "Dismiss" works;
density and glint changes re-lay rows without relaunch; every toggle has a
one-line footer explaining what it does.

### U11 — iPad and large widths

`Shell/ShellView.swift`, `Browse/IssueBrowseView.swift`.

- Issues, Review, Projects host `NavigationSplitView` (list → detail) at
  regular width; detail binds to `session.offline.cachedIssue(key:)`, not a
  copied `@State`, so swipe edits appear in the column.
- Selection in `@SceneStorage`; survives rotation and Stage Manager.
- Properties in `.inspector` at regular width; pills at compact.
- `.hoverEffect(.highlight)` on rows and pills; arrow keys move selection,
  Return opens, Space advances state where valid; `.defaultFocus` on lists.
- iOS 26: `.backgroundExtensionEffect()` under the sidebar edge.

Acceptance: rotating with an issue selected keeps it selected and visible;
a 1/3-width Stage Manager window falls back to compact with no clipped
toolbar; every shortcut appears in the Command-key overlay.

### U12 — Liquid Glass adoption and accessibility gate

`Package.swift`, `.github/workflows`, `Tests/`.

- CI builds against the iOS 26 SDK and runs the fallback path in an iOS 18
  simulator.
- Lint (Swift test over the source tree): no `glassEffect`,
  `GlassEffectContainer`, `.ultraThinMaterial`, `.regularMaterial` outside
  `Shell/`; no raw `.easeInOut(duration:)` outside `Motion.swift`.
- Snapshot matrix for Shell, Row, Now, Projects, Roadmap, Detail, Composer,
  Settings, Pulse × {Default, AX5, Reduce Transparency, Increase Contrast,
  Dark + Increase Contrast, Reduce Motion}.
- VoiceOver audit extended to every screen above.
- Contrast assertions: every ink/surface pair ≥ 4.5:1 across the three
  trait resolutions, in `TallylineCoreTests`.

Acceptance: CI fails on any glass or raw-animation token outside the allowed
files; all snapshot variants render without clipping; contrast test passes;
audit passes on every listed screen.

## Sequencing

U1 → U2 → U3 → U4 → U5 → U7 → U8 → U9 → U6 → U10 → U11 → U12.

U1 moves the floor and the shell so nothing is retrofitted. U2 and U3 are
pure foundations. Detail and composer (U7, U8) land before projects (U6) so
the project detail reuses a finished issue detail. Settings (U10) comes after
the pulse (U9) so Sync can show the same state. U12 runs last over all of it.

Coordination: #231 U7 ("agent-first home") is replaced by U5 here and should
be deleted from that plan; #231 keeps U1–U6 and U8. The duplicate copy of
this file on the #231 branch must be removed when it rebases.

## Risks

- **Floor bump** drops iOS-17-pinned devices. Acceptable for a companion
  app; recorded for Luke.
- **Glass and animation sprawl** from generated SwiftUI. The U12 lint exists
  because of this.
- **Pulse and Now feed lie when stale.** "As of" suffixes and sync-coupled
  refresh, never a separate timer.
- **Split-view edits.** Detail must observe the cache by key (U11) or swipe
  edits will not show in the column.
- **Settings sprawl.** Every toggle needs a footer and a reason; if a toggle
  cannot be explained in one line it is cut.
- **Review throttling.** Codex is over quota and CodeRabbit allows one
  review per hour here. Land one unit per PR; rely on Argus for the gate.

## Verification

- `TALLYLINE_CORE_ONLY=1 swift test` (Linux) for U2 decode and round-trip,
  U5 ordering, U12 contrast.
- CI: iOS 26 SDK build, iOS 18 fallback run, snapshot matrix, a11y audit,
  lint.
- Manual: iPhone compact pass; iPad in Stage Manager at 1/3, 1/2, full with
  external keyboard; airplane-mode pass for U8 and U9.
- `pnpm check` when fixtures or `ios-contract.test.ts` change.

## Blocked on Luke (not agent-buildable)

- Confirm the iOS 18 floor.
- App icon layers in Icon Composer (default, dark, tinted, mono).
- App Group `group.app.tallyline.ios` and extension App IDs (`ROADMAP.md`
  S5-U1); without them TestFlight builds lack widgets and share extension,
  and Sync → Cache cannot report the shared container.
- Production push relay key for a real sandbox push (needed for the
  Notifications test button).
- Sign in with Apple stays deferred.

## Non-goals

- Public intake backend, web helpdesk, operator-key surfacing (#231).
- Rich text or mentions in comments.
- Widgets reading roadmap data until U6 and U9 land.
- Release pipelines.
- Custom Liquid Glass in any content view.
- Web-parity settings.
