---
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan user-directed
external_source: cloudflare/vinext (github.com/cloudflare/vinext) — 9.2k★, MIT, TypeScript, pushed recently
---

# vinext migration eval — Next.js API on Vite, out from under Vercel

## Goal Capsule

Evaluate Cloudflare's vinext (Next.js API surface reimplemented on Vite 8 — App Router, RSC, Server Actions, middleware, `next/*` modules, deployable to Workers or anywhere via Nitro) as the migration path for tallyline's `apps/web` (Next 16.4). Deliverable: `vinext check` compat report + a migrate-or-stay decision. **portfolio-hub (Next 16.3) is the second candidate — one eval covers both.**

## Product Contract

### Why it matters here

Two Next apps in the fleet (tallyline `apps/web`, portfolio-hub) inherit Vercel's gravity: hosting assumptions, Next-version upgrade treadmill, Vercel-priced features. vinext is the wedge — deploy Next-shaped apps to Workers (which we already run: shippedit, kurultai tunnels) or anywhere Nitro speaks.

### Honest constraints (from upstream's own docs)

- Known gaps: Cache Components / partial prerendering, build-time image/font pipeline, some native modules in RSC dev mode.
- Their own FAQ says **OpenNext remains the safer option** for production today. This plan must not pretend otherwise — it's an *evaluation* of maturity, not a migration commitment.
- They ship an agent skill (`npx skills add cloudflare/vinext`) that drives agent-led migration — use it; that's the intended path.

### Scope boundaries

- **In:** `vinext check` against `apps/web` (read-only compat scan), then a non-destructive `vinext init` beside Next on a branch, build + smoke the app on Vite, honest gap report.
- **Out:** switching deploys, touching production config, migrating portfolio-hub in this plan (it gets the *findings*, its own call later).

### Requirements

1. `vinext check` on `apps/web` → capture the compat-gap report verbatim; each gap classified: blocker / workaround / doesn't-apply.
2. Branch-only `vinext init` beside Next (non-destructive mode); `vinext` build of the app; smoke the key routes.
3. Gap report `docs/decisions/vinext-eval.md`: migrate-now | wait-for-maturity (name the blockers) | never (defended reason). Include portfolio-hub applicability note.
4. Deploy-target note: if viable, Workers is the interesting target (we're already a Cloudflare shop).

### Acceptance examples

- The eval names actual blockers found *in this codebase*, not vinext's generic gap list.
- A verdict exists and cites the check output + build result.

## Repo Touchpoints

- `docs/decisions/vinext-eval.md` (new)
- `apps/web/` — branch-local init artifacts only

## Test Scenarios

1. `vinext check` produces a gap report (even "0 blockers" is a result — then build must still pass).
2. Vinext dev server + build both complete; core routes render.
3. SSR/API routes in apps/web behave — that's where compat usually breaks.

## Risks / Honest Notes

- 9.2k★, months old, 635 open issues — fast-moving, unfinished. The OpenNext-safer admission is upstream's own; treat "migrate" as the unlikely verdict unless the check comes back remarkably clean.
- Even a "wait" verdict pays off: the gap report becomes the tripwire — re-run `vinext check` when their issue list shrinks.
- Next 16 is *very* current; the tool may lag real-world Next features more than its README suggests. Measure, don't assume.
