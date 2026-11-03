---
title: iOS projects, roadmap, and native craft
created: 2026-11-03
status: draft
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-brainstorm
---

# iOS: projects, roadmap, and native craft

## Goal Capsule

The iPhone app can read and write issues but shows nothing about the plan behind
them: no projects, no roadmap, no sense of what is on track. Close that gap and
raise the whole app to the native bar set by Linear Mobile — dense, glyph-led,
keyboard-aware, and built out of iOS idioms rather than shrunken web lists.

## What exists today (verified 2026-11-03)

- `apps/ios` is ~1,670 lines across 9 files. Screens: issue list, issue detail,
  review queue, board tabs, settings, sign-in.
- `TrackerClient` has `issues`, `issue`, `createIssue`, `updateIssue`,
  `comments`, `addComment`, `reviewIssue`, `projects`, `cycles`, `labels`,
  `teams`, `members`, `agents`, `reviewQueue`.
- Models are lossy: `Project` decodes only `id`, `name`, `description`,
  `status`; `Cycle` has no issue counts. Nothing decodes milestones.
- The API already serves everything the missing screens need:
  - `GET /v1/workspaces/:ws/roadmap/summary` → `totals`, `projects[]`
    (`projectId,total,done,closed,inProgress,inReview`), `milestones[]`
    (`milestoneId,total,done`), `merges[]`, `doneSince`
  - `GET /v1/workspaces/:ws/milestones` (flat list, one request)
  - `GET /v1/workspaces/:ws/projects`, `/cycles`, `/labels`, `/members`,
    `/agents`

## Design bar

From the Linear Mobile App Store screenshots (captured 2026-11-03, reference
only — do not copy assets):

1. **Dense, glyph-led rows.** A status glyph per row, one line of metadata,
   grouping headers in small caps. No cards, no shadows.
2. **Segmented top filters** (`Priority | Other`, `Overview | Activity |
   Projects`) instead of dropdowns.
3. **Floating bottom action bar** with four icons (filter, search, create,
   assistant) that never scrolls away.
4. **Inline property pills** in the create sheet and issue detail — tap a chip,
   pick from a sheet, no navigation.
5. **Keyboard accessory composer** on the issue thread with an assistant action.
6. **Dark-first**, accent used only for state and agent presence.

## Units

Each unit is one work order (`labels: work-order`) with its own acceptance
criteria. U1 is pure Swift and testable on Linux; the rest are SwiftUI.

### U1 — Widen the client: roadmap summary, milestones, project detail

`TrackerClient` + `TrackerModels`.

- Decode `RoadmapSummary` (`totals`, `projects`, `milestones`, `merges`,
  `doneSince`) and add `roadmapSummary(ws:since:)`.
- Add `milestones(ws:)` over `/v1/workspaces/:ws/milestones`.
- Widen `Project` to every column the endpoint returns (target date, lead,
  status, health inputs) with optional fields so old fixtures still decode.
- Keep the wire contract honest: extend
  `Tests/TallylineCoreTests/Fixtures/*.json` from `ios-contract.test.ts` and add
  decode tests for the new types.

Acceptance: fixtures decode; `ios-contract.test.ts` still fails on shape drift;
no `any`-style optionality that hides a missing field.

### U2 — Projects screen

`ProjectListView` + `ProjectDetailView`.

- List: name, status chip, progress ring from `/roadmap/summary` counts,
  target date, owner avatar. Sort by status then target date.
- Detail: header with ring + counts, then issues for that project grouped by
  state, each row opening the existing issue detail.
- `.refreshable` and `.searchable`; empty state that offers "Create project".

Acceptance: opening a project from the list shows only that project's issues;
counts match `/roadmap/summary` exactly (no client-side guessing); pull to
refresh re-reads the summary.

### U3 — Roadmap timeline

`RoadmapView`.

- Horizontal month grid; lanes for active cycles and milestones over the next
  and previous period; each bar carries a health ring from the summary.
- Sticky month header, snapping scroll, today marker.
- Tap a bar → its project or milestone detail.

Acceptance: a workspace with no milestones renders an empty state, not a blank
canvas; the today marker sits on the correct month for the device timezone.

### U4 — Native shell

- `TabView` with Issues, Projects, Roadmap, Inbox; large titles; each tab keeps
  its own `NavigationStack` so state survives switching.
- `.searchable` on Issues, `.refreshable` everywhere data is fetched.
- Sheets use detents; issue detail opens as a sheet on iPad, push on iPhone.
- Deep links: push notifications and widgets already route through
  `tallyline://open/...`; add `/projects` and `/roadmap` destinations.

Acceptance: every tab restores its scroll position after switching; a cold
launch from a push deep link lands on the right screen with a back stack.

### U5 — Issue detail craft

- Inline property pills (state, priority, assignee/delegate, project, cycle,
  labels) that open pickers in a sheet with detents.
- Swipe actions on list rows (state change, assign), context menu (copy key,
  copy link, assign to me).
- Haptics on state change and review action using the existing `Haptics` seam.
- Dynamic Type and VoiceOver labels verified at the largest size.

Acceptance: changing state from the pill updates the list without a full
reload; VoiceOver reads a row as one sentence including project and state.

### U6 — Create composer

- Title first, then the same inline chips as U5, then description.
- Keyboard accessory bar with attach, label, and agent assignment.
- Files into the team last used (`TeamMemory`), through the outbox.

Acceptance: creating offline parks in the outbox and shows a pending badge;
assigning an agent is possible without leaving the sheet.

### U7 — Offline covers the new surfaces

- Cache the roadmap summary and project lists alongside the issue cache.
- Surface outbox state (pending, retrying, parked) in the shell, not only in
  Settings.

Acceptance: airplane mode shows last-known projects and roadmap with a stale
marker; a parked write is visible without opening Settings.

### U8 — Accessibility and iPad

- VoiceOver rotors on project and roadmap lists ("At risk", "No owner").
- Split view: project list → project detail → issue detail, with the detail
  pane keeping selection.
- Reduce Motion: the timeline snaps without animation when enabled.

Acceptance: CI's accessibility audit runs on the projects screen as well as
sign-in; the split view keeps selection across rotation.

## Sequencing

U1 → U2 → U4 → U3 → U5 → U6 → U7 → U8. U1 gates everything; U4 lands the shell
before the timeline so the shell is not retrofitted around it.

## Blocked on Luke (not agent-buildable)

- App Group `group.app.tallyline.ios` registration and App IDs for the widget
  and share extensions (S5-U1) — without it, TestFlight builds ship without
  extensions.
- Production push relay key for a real sandbox push (S4 push).
- Sign in with Apple: explicitly deferred; the app pairs with a device
  credential today and OAuth tokens are audience-bound to `/mcp`.

## Non-goals

- Linear-style release pipelines (deferred in the roadmap already).
- A web-parity settings surface on iOS.
- Widgets reading roadmap data (they stay issue-count only until U7 lands).
- Comments/mentions rich text on iOS this pass.
