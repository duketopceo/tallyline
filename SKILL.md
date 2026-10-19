---
name: tallyline
description: Work the tallyline issue board — claim, start, comment, and close issues via the `tallyline` CLI or MCP tools. Use when a task lives on a tallyline board or the user says an issue is assigned/claimed/ready.
---

# tallyline — agent surface

tallyline is a self-hosted issue tracker where you are a first-class actor:
issues assigned to you are yours to work, and every action you take is
attributed to your registered agent identity (the board renders a sparkle on
agent-touched items — that provenance is load-bearing, never impersonate a
human and never spoof another agent's `x-actor-id`).

## Credentials

You need three things (ask the human if missing — do not invent them):

- `TALLYLINE_API_URL` — e.g. `http://localhost:4000`
- `TALLYLINE_TOKEN` — a `tly_agt_*` key minted for YOUR agent identity
- `TALLYLINE_WORKSPACE` — the workspace slug (e.g. `acme`)

Your key has scopes: `read` covers all GETs; `write` covers mutations. A
`403 FORBIDDEN_SCOPE` means the key lacks `write` — report that to the human
instead of working around it. `401` means the key is wrong or expired.

## Working the board

Lifecycle: `triage → backlog → todo → in_progress → in_review → done`
(`canceled`/`duplicate` are terminal escapes). Transitions are enforced —
illegal jumps return `409 INVALID_TRANSITION`. The CLI walks legal paths for
you (`tallyline done` chains through `in_review`); if scripting raw PATCHes,
walk the machine yourself.

Claim etiquette — the contract that keeps multi-agent boards sane:

1. `tallyline ready` — pick unassigned (or yours) `todo` work, priority-ordered.
2. `tallyline claim <KEY>` — assign to yourself BEFORE working. A claimed
   issue is a promise: another agent may see it and leave it alone.
3. `tallyline work` — if you were *dispatched* (assigned/@mentioned), this
   spawns your harness with full issue context in an isolated worktree and
   reports the session back automatically. Local runs only.
4. `tallyline start <KEY>` — flips to `in_progress`. Do the work.
5. Comment progress on anything non-trivial:
   `tallyline comment <KEY> "what I found / what I'm doing"`. If you stall or
   get blocked, comment that too — don't hold a claim silently.
6. `tallyline done <KEY>` — walks to `done` through legal transitions. Mark
   done only when the work is verifiably complete; `in_review` exists for a
   reason.

Never claim work already assigned to another actor unless the human says so.
Never mark someone else's issue done.

## Importing a plan

When you finish writing a plan file (a ce-plan document with `### U<N>.` unit
headings), put it on the board in one step, dry run first:

1. `tallyline import-plan <plan.md> --project <name> --scope <KP>` — writes
   nothing; prints the diff (create / update / unchanged / ambiguous) and a
   `diffHash`. MCP: `import_plan` with `markdown`, `repo`, `path`, `sha`.
2. Show the human the diff, ambiguous units especially. Never merge an
   ambiguous unit yourself; ask, then pass `--resolutions` / `resolutions`.
3. Apply only after the human has seen that diff: add
   `--apply --diff-hash <hash>` (MCP: `mode: "apply"`, `diffHash`). A
   `409 STALE_DIFF` means the board moved — show the new diff, get the hash
   again.

You cannot import history: done and in-progress state from `--evidence` needs
a human owner/admin token, and an agent key gets `403 FORBIDDEN_HISTORICAL`.
Do not work around it. See `docs/import.md`.

## Reference

- Branch convention: `<KEY>-slug` — e.g. `ENG-42-rate-limit-responses`.
- Commits: conventional (`feat:`, `fix:`) and reference the key.
- CLI: `tallyline ready|next|claim|start|done|state|comment|create|list|search|show|triage|import-plan|events` — `--json` on everything for machine reads; `events --follow` streams the live board.
- MCP: `whoami, list_issues, ready, get_issue, create_issue, update_issue, triage_issue, comment, claim, list_agents, list_teams, list_labels, list_projects, list_cycles, create_cycle, assign_cycle, list_events, create_project, update_project, import_plan` — setup per harness in `docs/agents.md`.
- REST: `GET /openapi.json` on the API host. Errors carry `{error:{code,message}}` — surface the code, don't guess.
