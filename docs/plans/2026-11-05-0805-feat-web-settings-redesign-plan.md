---
title: Web Settings Redesign - Plan
type: feat
date: 2026-11-05
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Web Settings Redesign - Plan

## Goal Capsule

- **Objective:** A person who opens Settings on the web can find any setting in one look, on a laptop or a phone, by keyboard or pointer, and the screen reads as the same product as the iOS Settings sheet.
- **Means:** One shared settings layout with a grouped section navigation and an overview page, replacing the 16-item tab strip each page renders today (KTD1, KTD2).
- **Authority:** This plan, then DESIGN.md (design contract), then the existing settings pages' behaviour, which must not change.
- **Stop:** Do not add backend endpoints or new settings. Do not change what any existing panel does, who may use it, or any `/api/settings/*` route.
- **Who ships:** An implementing agent builds, tests and opens the PR with before/after screenshots from a local dev server. The owner merges and decides deploys.

## Product Contract

### Summary

Web Settings today is 16 sibling pages. Each draws its own 48px header holding the page title plus a horizontally scrolling strip of 16 equal-weight links (`apps/web/components/settings-tabs.tsx`). At 1440px the strip collides with the header meta; at 390px only five items are visible and nothing says more exist. `/settings` redirects to Members. iOS Settings (`apps/ios/Sources/tallyline_ios/Settings/SettingsView.swift`) is a grouped list: a profile card first, grouped rows, the destructive action last.

### Problem Frame

There is no hierarchy: personal, workspace, agent and integration settings sit side by side with no grouping, so finding "where do I rotate an agent key" means scanning 16 labels. The phone layout hides most of the navigation. Web and iOS present settings differently, so the product does not feel like one thing.

### Requirements

- R1. Settings navigation is grouped into labelled sections: Account (profile and security, appearance, devices, personal tokens), Workspace (general, members, invites, usage, setup checklist at `/welcome`), Planning (labels, projects, cycles), Agents and AI (agents, AI assistant), Integrations and access (integrations, sign-in providers). The Dev inbox entry appears only for instance admins.
- R2. `/settings` is an overview page: a profile card first (initials, name, email, workspace, links to Account), then the same groups as rows with one-line descriptions, then a Danger zone group last (delete account, delete workspace for owners, sign out), mirroring the iOS sheet.
- R3. Every existing settings URL keeps working and renders the same panels with the same behaviour, permissions and copy. Each page keeps its `h1` text.
- R4. At 768px and wider every sub-page shows the section navigation as a persistent sidebar beside the page; the current page is marked with `aria-current="page"`. The overview (`/settings`) is itself the navigation at every width, so it renders without the sidebar. Below 768px a sub-page shows a back link instead of the sidebar: to `/settings`, or to the parent page for nested routes (`/settings/agents/connect` → Agents, `/settings/ai/openrouter` → AI, whose existing in-page back link stays).
- R5. Navigation is a `nav` landmark labelled "Settings", with group headings, focus-visible styling and a logical tab order; every control is reachable by keyboard; screens pass the existing axe checks in dark, light and at 1440 and 390.
- R6. Tokens only (silver-lining); one accent per screen; hairline surfaces; checked in light and dark.
- R7. The `g ,` shortcut, the palette "Go to Settings" entry and the sidebar Settings link open `/settings`.

### Success Criteria

- Before/after screenshots in the PR at 1440 and 390, dark and light, for the overview and at least Members, Account, Workspace and Agents.
- Existing settings e2e specs pass with no edits to their behavioural assertions; new e2e coverage proves grouping, current-page marking, keyboard reach, the mobile back link and axe on the overview.

### Scope Boundaries

- No notifications settings section: web has an inbox (`/notifications`) but no notification preferences backend; iOS notification settings are device push settings. Inventing one would add backend behaviour. Recorded as a follow-up.
- No "Teams" management page: teams have no web settings page today; adding one is new behaviour.
- No change to panel internals (forms, dialogs, secret reveal), API routes, or permission checks.
- Linked identities / Sign in with Apple on web is roadmap U6, not this plan.

## Planning Contract

### Key Technical Decisions

- KTD1. **A route-segment layout owns the chrome.** Add `apps/web/app/(app)/settings/layout.tsx` (server component) that reads `/v1/auth/me` once for role and instance-admin flags and renders the section navigation beside `{children}`. Chosen over editing the strip in place, which keeps 16 copies of the header and cannot give a persistent sidebar.
- KTD2. **One source of truth for sections.** A typed `SETTINGS_SECTIONS` list in `apps/web/lib/settings-nav.ts` (pure data plus a `isActive(pathname, href)` helper) drives the sidebar, the overview and the tests. Chosen over separate lists per surface, which would drift.
- KTD3. **Pages keep their `h1`, lose the strip.** `SettingsTabs` is deleted; `PageHeader` in `components/settings/ui.tsx` and every inline settings header render the title and meta only, through one `SettingsHeader` component that also carries the mobile back link. Existing e2e assertions on `h1` names and on `nav[aria-label=Settings]` links ("Agents", "Tokens", "Usage") keep working because the sidebar uses those labels.
- KTD4. **Responsive by CSS, not by JS.** The sidebar is `hidden md:flex` (and not rendered on `/settings`, decided from the pathname in the client nav); the back link is `md:hidden`. The sidebar comes first in DOM order, is sticky and scrolls independently of the page. No viewport detection, no hydration mismatch.
- KTD5. **Danger zone stays where the action lives.** Delete account and delete workspace remain on their pages (their dialogs and copy are tested); the overview's Danger zone rows link to those pages (no fragment, so page bodies stay untouched), and the sign-out row is a `<form action="/api/logout" method="post">` button, the same mechanism the shell uses.

### Assumptions

- Non-admin members can open Settings by URL today and see "Requires admin access" on admin pages; the sidebar keeps listing those pages (no behaviour removed) but marks nothing differently. The shell only shows its Settings link to owners and admins; that is unchanged.
- `tools/e2e/scripts/seed-demo.mjs` on `main` looks for the old `dok_session` cookie name, so every call after bootstrap fails with 401 (observed while capturing the baseline); the one-line fix to `tly_session` is in scope because the screenshot evidence depends on it.
- Baseline (before) screenshots are captured from the unmodified base commit before U1 starts (U0, done during planning).

### Sequencing

U0 (baseline screenshots on the base commit) first, then U1, U2, U3; U4 runs last against the finished UI.

## Implementation Units

### U1. Section model and navigation

**Goal:** Grouped, accessible section navigation from one data source.

**Requirements:** R1, R4, R5, R6.

**Dependencies:** none.

**Files:** `apps/web/lib/settings-nav.ts` (new), `apps/web/lib/settings-nav.test.ts` (new), `apps/web/components/settings/settings-nav.tsx` (new, client: `usePathname` for `aria-current`), `apps/web/app/(app)/settings/layout.tsx` (new).

**Approach:** Sections carry `id`, `label`, `items[{ href, label, description, adminOnly?, instanceAdminOnly? }]`. Layout: `flex` row; sidebar `w-56 shrink-0 border-r border-lining-faint` with group headings in the existing small-caps label style used by the app sidebar (WORK / WORKSPACE). Active item uses the same `bg-surface-2 text-ink` treatment the strip used.

**Patterns to follow:** `apps/web/components/app/shell.tsx` sidebar groups; `settings-tabs.tsx` active logic (`pathname.startsWith`).

**Test scenarios:**
- `isActive` marks `/settings/agents/connect` as Agents, `/settings/ai/openrouter` as AI, and `/settings` as no item.
- Every href in `SETTINGS_SECTIONS` corresponds to an existing `page.tsx` under `app/(app)/settings` or `/welcome` (filesystem check in the unit test).
- Instance-admin-only items are filtered out for a non-instance-admin.

**Verification:** web Vitest and typecheck pass.

### U2. Overview page

**Goal:** `/settings` mirrors the iOS sheet.

**Requirements:** R2, R7.

**Dependencies:** U1.

**Files:** `apps/web/app/(app)/settings/page.tsx`, `apps/web/components/settings/settings-overview.tsx` (new), `apps/web/components/app/shell.tsx`, `apps/web/components/app/global-actions.tsx`, `apps/web/components/global-nav.tsx`.

**Approach:** Profile card (initials disc on `surface-3`, name, email, workspace name, chevron) linking to `/settings/account`; grouped rows (label + description + chevron) in hairline panels; Danger zone last with `text-urgent` rows. Repoint the four `/settings/members` sites to `/settings`: `shell.tsx` palette action and sidebar item, `global-actions.tsx` and `global-nav.tsx`.

**Test scenarios:** covered by U4 e2e (overview groups, profile card link, danger rows, shortcut target).

**Verification:** typecheck; manual check in the local stack.

### U3. Page headers without the strip

**Goal:** Every settings page renders under the new layout with its own title and meta.

**Requirements:** R3, R4.

**Dependencies:** U1.

**Files:** `apps/web/components/settings/ui.tsx` (`PageHeader` → uses `SettingsHeader`), `apps/web/components/settings/settings-header.tsx` (new), every `apps/web/app/(app)/settings/**/page.tsx` that imports `SettingsTabs`, `apps/web/components/settings-tabs.tsx` (deleted), `apps/web/lint-design-allowlist.json` (regenerated with `pnpm lint:design --update-allowlist`, never hand-edited).

**Approach:** Replace each inline `<header>…<SettingsTabs/>…</header>` with `<SettingsHeader title meta? actions?>`; keep the right-side meta/links (member count, "install App", workspace slug) as `meta`/`actions`. Do not touch page bodies.

**Test scenarios:** existing e2e (`settings-agents`, `settings-ai`, `trust-and-usage`, `account-lifecycle`, `phone-pairing`, `theme-toggle`, `a11y`) pass unchanged.

**Verification:** `rg SettingsTabs apps/web` is empty; typecheck and lint pass; design lint passes.

### U4. Coverage and evidence

**Goal:** Prove the redesign and show it.

**Requirements:** R1–R7, Success Criteria.

**Dependencies:** U1–U3.

**Files:** `tools/e2e/tests/settings-layout.spec.ts` (new), `tools/e2e/scripts/shoot.mjs` (add settings screens behind `SHOOT_ONLY`), `tools/e2e/scripts/seed-demo.mjs` (cookie name fix).

**Test scenarios:**
- Overview shows the profile card and the five groups plus Danger zone in order; the profile card links to `/settings/account`.
- Sidebar at 1440: group headings present; clicking Labels navigates and marks it `aria-current="page"`.
- Keyboard: focus the Members link, Tab to Invites, Enter navigates.
- 390: `/settings/members` hides the sidebar and shows a "Settings" back link that returns to `/settings`.
- `g ,` opens `/settings`.
- axe: already covered for `/settings` and `/settings/members` by `a11y.spec.ts` (both themes, both widths); the new spec adds a check on `/settings/agents/connect` at 390 for the nested back link.
- Sidebar link accessible names stay the bare labels (descriptions outside the link name), because existing specs match by name.

**Verification:** the e2e suite passes locally against the disposable e2e stack and in CI; before/after PNGs attached to the PR.

## Verification Contract

| Gate | Check |
|---|---|
| Web | `pnpm --filter @tallyline/web typecheck`, `lint`, `test` |
| Design | `pnpm lint:design` |
| e2e | `pnpm --filter @tallyline/e2e test` (disposable stack, never the dev DB) |
| Evidence | before/after screenshots from a local dev server only |

## Definition of Done

- [ ] All settings URLs render under the grouped layout; `SettingsTabs` is gone.
- [ ] `/settings` is the overview; shortcuts point to it.
- [ ] New and existing e2e specs pass; axe clean in both themes at both widths.
- [ ] PR carries before/after screenshots and lists the notifications follow-up.
- [ ] No abandoned experimental code left in the diff.

## Open Questions

- Should web gain notification preferences (per-event email/push) to fill the Notifications group? Needs backend; follow-up for the owner.

## Sources

- DESIGN.md; `apps/ios/Sources/tallyline_ios/Settings/SettingsView.swift`; `apps/web/components/settings-tabs.tsx`; `tools/e2e/tests/*settings*`, `trust-and-usage.spec.ts`, `account-lifecycle.spec.ts`, `a11y.spec.ts`.
