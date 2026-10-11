# PR Briefs — implementation plan

Created: 2026-10-20 · Source: in-conversation brainstorm (ce-plan-bootstrap)

## Problem

Agents write PRs faster than humans read diffs; review rubber-stamps. A **Brief** — a plain-English artifact filed with the PR saying what it did and why — replaces the diff as the review document. The diff becomes the evidence appendix.

## Product contract (settled in brainstorm)

- Name: **Brief** (docket lineage — the PR files a brief, the human rules). No "AI" naming anywhere.
- Author-written: the agent that wrote the PR writes the brief — it knows intent. Tallyline stores, stamps, serves; it does not summarize diffs as the primary path.
- Page: `/briefs/[key]` on the synced issue — simple-English explainer is the star; a pill toggle (Phosphor `BookOpen` | `Code`, regular 16px) reveals the reviewer layer (moves, blast radius, watch flags). English pinned in both modes.
- Spec v1, published at MCP resource `tallyline://specs/brief`, `tly brief --spec`, and `docs/briefs.md`:
  - `gist` required ≤400 chars plain English (what + why)
  - `bullets` required 0..N ≤200 chars each
  - `moves` optional {label, files[]}
  - `watch` optional {file, lines, why} — the 2–3 hunks worth human eyes; `watch: []` is a signed claim
  - `intent` optional divergence notes vs the linked issue
  - `sha` required — head commit covered; stale-flag on later pushes
- Shape enforces brevity, not length — large PRs may be long.
- Quality gate: `POST /v1/workspaces/{ws}/issues/{key}/review` action=approve → `422 BRIEF_REQUIRED` when the linked PR has no brief covering its head sha (per `issue_external_refs`). GitHub commit status `tallyline/brief` is per-repo opt-in, not v1.
- Workspace opt-in: `workspaces.briefs_enabled` — consents to token spend for **generated drafts** only; submitted briefs are always allowed when the feature exists. Default off.
- Markdown-lite brief body (paragraphs + bullets, no headings).
- Anchored to `issue_external_refs` github PR links — no PR entity.

## Implementation units

- **U0 Schema+spec**: `issue_briefs` table (workspace_id, issue_id, repo, pr_number, author actor, sha, gist, bullets jsonb, moves jsonb, watch jsonb, intent, source `submitted|drafted`, created_at; unique (workspace_id, repo, pr_number) latest per sha). `workspaces.briefs_enabled bool default false`. Migration `drizzle/0029`. `docs/briefs.md` spec doc.
- **U1 API**: `POST /v1/workspaces/{ws}/issues/{key}/brief` (agent_write — submit; validates spec caps, sha required), `GET …/brief` (issue-linked PR briefs), `POST …/brief/draft` (session or agent_write; 403 unless `briefs_enabled`; generates from GitHub diff via llmEnabled). Service `services/briefs.ts`. Envelope per repo conventions.
- **U2 Gate**: review-approve in `services/issues.ts` → `422 BRIEF_REQUIRED` when issue has github PR ref whose brief is absent or stale-sha.
- **U3 Spec surfaces**: MCP resource `tallyline://specs/brief` in apps/mcp-server; `tly brief <KEY> --pr N [--file|-|--stdin]` + `tly brief --spec` in tools/cli; OpenAPI doc + route-diff parity.
- **U4 Toggle UI**: Settings → workspace features: "PR briefs — let Tallyline draft plain-English briefs for PRs missing one (uses LLM tokens)" checkbox writing `briefs_enabled`.
- **U5 Brief page**: `/issues/[key]` gets a Brief block when linked PR has a brief (explainer + toggle); or `/briefs/[key]` dedicated page. Simple mode = gist + bullets + provenance (`by devin · covers abc1234 · stale`); review mode adds moves/watch/blast.
- **U6 Tests**: submit/validate/stale-sha/dedupe-latest/tenancy/review-gate/toggle-403/spec caps; permission-matrix + TABLE_ENDPOINTS + matrix-ops + seed rows; e2e smoke of brief block.

## Out of scope (v1)

Ask-the-diff Q&A, non-GitHub forges, GitHub commit-status check, auto-approval, brief on unlinked PRs.

## Risks

- Gate-not-read (rubber stamp theatre) — mitigated by watch flags + sha staleness; residual accepted.
- Draft fallback needs repo diff access via existing github sync credentials — confirm app token scope covers `contents:read`.
- Brief attached to issue↔PR link means issues without linked PRs show nothing — intended.

## Files

api: `db/schema.ts`, `services/briefs.ts`, `services/issues.ts` (gate), `routes/briefs.ts` (+mount), `openapi.ts`, `drizzle/0029*`, tests. mcp: `src/tools.ts` (submit_brief), resource. cli: `src/commands.ts` (`brief`). web: `app/(app)/issues/[key]` brief block or `app/(app)/briefs/[key]/page.tsx`, settings toggle. types: shared brief contract.
