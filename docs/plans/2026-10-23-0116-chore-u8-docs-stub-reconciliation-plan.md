---
title: "U8 Docs and stub reconciliation - Plan"
type: chore
date: 2026-10-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/plans/2026-10-17-0000-feat-tallyline-full-roadmap-plan.md (U8 / R22)
---

# U8 Docs and stub reconciliation - Plan

## Goal Capsule

- **Objective:** The public repo describes the stack that exists: Postgres-only, no BullMQ/Redis claims, no empty stub workspaces, and status text that matches shipped work (R22).
- **Means:** Delete stub dirs, rewrite AGENTS/README/LICENSING stack lists, refresh the README Status gaps line, leave ROADMAP pointer as-is (already correct).
- **Authority:** Full roadmap U8 unit; this plan is the executable slice for one PR.
- **Stop conditions:** Stop if deleting a stub breaks `pnpm install` or any package still imports `@tallyline/dispatch` / `@tallyline/ui` / `@tallyline/config`. Do not close GitHub issues that need a human confirmation of prod URL (#88) — leave a comment draft note in the PR instead if the prod link is unknown.
- **Execution profile:** One PR; docs + workspace deletion only.

## Product Contract

### Summary

After Redis removal and the PM-slice merges, contributor-facing docs still advertise a BullMQ dispatch worker, Redis, and empty `packages/ui` / `packages/config` / `services/dispatch` workspaces. Dispatch already lives in `apps/api/src/services/dispatch.ts`. U8 makes the docs and workspace layout match reality.

### Problem Frame

- `AGENTS.md` still says BullMQ + Redis in the product blurb and Key Files list.
- `README.md` Stack lists `services/dispatch` and empty shared packages; Status still claims missing revoke route and CI.
- `services/dispatch` is a stub (`DispatchAdapter` interface only); `packages/ui` and `packages/config` contain only `.gitkeep`.
- Real dispatch is `apps/api/src/services/dispatch.ts` (documented correctly in `docs/adapters.md`).

### Requirements

- R1. No live claim of BullMQ or Redis outside CHANGELOG historical notes and research/plan archives.
- R2. Stub workspaces `services/dispatch`, `packages/ui`, and `packages/config` are removed from the tree and from lockfile workspace entries.
- R3. AGENTS.md and README.md Key Files / Stack lists name only packages that exist (`packages/types`, `packages/silver-lining`, apps, tools, ops).
- R4. README Status no longer lists agent-key revoke or CI as open gaps (both shipped).
- R5. LICENSING.md AGPL row no longer names `services/dispatch` as a present path.
- R6. `pnpm install` and `pnpm check` (or the repo's equivalent typecheck/lint gate) succeed after the deletions.

### Scope Boundaries

**In:** docs listed above, stub directory deletion, lockfile refresh from install.

**Out:** U2/U3 ops scripts; closing #88/#1 without a confirmed prod URL; rewriting research/plan historical documents; changing `apps/api` dispatch runtime.

### Success Criteria

- Repo-wide `rg -i 'bullmq|redis'` finds no live claims outside `CHANGELOG.md`, archived `docs/plans/` / `plans/`, and `docs/research/` (historical notes only).
- `services/dispatch`, `packages/ui`, `packages/config` directories absent; none appear as importers or package names in `pnpm-lock.yaml`.
- Install + check green; required CI checks on the PR pass (or a named exception is recorded and the plan stays incomplete).

### Open Questions

None blocking. Deferred: comment/close #88 and update #1 once a public prod URL is confirmed by the operator.

## Planning Contract

### Key Technical Decisions

- KTD1. **Delete stubs; do not replace with packages.** Shared UI is in `apps/web` / `packages/silver-lining`; config lives in repo root / package-local tsconfigs. Empty workspaces add confusion only.
- KTD2. **Keep product "Dispatch" language in README.** Dispatch as a feature remains; point Stack/Key Files at `apps/api/src/services/dispatch.ts`, not a separate worker package.
- KTD3. **Do not edit archived plans** under `docs/plans/` or `plans/` that mention the stubs historically.
- KTD4. **Refresh pnpm-lock.yaml** by running `pnpm install` after deletion so the `services/dispatch` workspace imprint disappears.

### High-Level Technical Design

1. Delete the three stub trees.
2. Patch AGENTS.md, README.md, LICENSING.md (and CONTRIBUTING.md only if a stale claim appears).
3. `pnpm install` to refresh the lockfile.
4. Run verification commands.

### Assumptions

- No consumer imports `@tallyline/dispatch`, `@tallyline/ui`, or `@tallyline/config` (verified pre-plan).
- `pnpm-workspace.yaml` globs (`packages/*`, `services/*`) need no edit once empty dirs are gone.

## Implementation Units

### U1. Delete stub workspaces

- **Goal:** Remove empty/stub packages from the monorepo.
- **Files:** `services/dispatch/` (entire), `packages/ui/` (entire), `packages/config/` (entire), `pnpm-lock.yaml` (via install).
- **Approach:** `git rm -r` the three trees; run `pnpm install` at repo root.
- **Test scenarios:** no package.json name `@tallyline/dispatch`, `@tallyline/ui`, or `@tallyline/config` remains; lockfile has no `services/dispatch:`, `packages/ui`, or `packages/config` importer keys; `pnpm -r list --depth -1` does not list the deleted names.
- **Verification:** `pnpm install` exit 0; `test ! -d services/dispatch && test ! -d packages/ui && test ! -d packages/config`.

### U2. Reconcile contributor docs

- **Goal:** AGENTS/README/LICENSING describe the real layout and status.
- **Files:** `AGENTS.md`, `README.md`, `LICENSING.md`; touch `CONTRIBUTING.md` only if needed.
- **Approach:** Rewrite product blurb and Key Files / Stack; Status gaps → point at ROADMAP full plan and drop revoke/CI claims; LICENSING table drops `services/dispatch`.
- **Test scenarios:** repo-wide `rg -i 'bullmq|redis'` (excluding CHANGELOG + archived plans/research) empty; README Stack does not list `packages/ui` or `packages/config`; AGENTS Key Files does not list stub paths; Status does not claim missing revoke or CI; landing/marketing copy does not claim Redis.
- **Verification:** ripgrep checks above; human skim of README Status.

## Verification Contract

- `pnpm install`
- `pnpm check` if present; else `pnpm turbo run typecheck lint` (and record which).
- Ripgrep assertions from R1 and U2 test scenarios.
- No need for API unit tests (docs/workspace only). Optional: leave `pnpm --filter ./apps/api test` unrun unless install/check fails.

## Definition of Done

- U1 and U2 complete; verification commands recorded with exit codes.
- PR open against `main`; required CI checks pass (LFG babysit to decided); **do not merge**.
- ROADMAP.md pointer left intact (already correct).
