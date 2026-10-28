# Roadmap pulse

The roadmap's top band and the `/roadmap?push=1` full-screen view. One server
aggregate feeds both; the page no longer loads `issues?limit=200` and counts
client-side, so a project with more than 200 issues reads true.

## Data

`GET /v1/workspaces/:ws/roadmap/summary?since=<iso>` (read scope) returns
exact per-project counts by state, `doneSince` (distinct issues that moved to
`done` in the window and are still done), per-milestone `done/total`, a
15-item open-first sample per project for the detail panel, and up to 40
"shipped" items. `since` defaults to 24h, is clamped to now and to 31 days.

The web app proxies it at `/api/roadmap/summary` and the page server-renders
the first paint with the 24h default. "Today" means local midnight, so the
today / 24h / 7d toggle is a client choice (kept in localStorage); the client
refetches with its own `since`.

## Shipped ticker

An item is one ticket: its `pr_merged` event and the `state_changed → done`
move are folded together. The actor is whoever moved the ticket; when only a
merge exists it falls back to the PR author.

`pr_merged` events are recorded by `services/pr-merge-events.ts`, called from
the `pull_request` webhook dispatch right beside `onPullRequest`. It names a
ticket by the branch (as the existing linker does) **or** by `(KEY-123)` at the
end of the PR title. It is idempotent on the PR url and **only records**; it
never moves a ticket, so it cannot fight the state machine (agents cannot move
`in_review → done`).

A merge done with `gh` and no webhook leaves no `pr_merged` event; the ticket
still appears, as a done move, without a PR link.

## Live

The browser subscribes to `/api/events/stream`. `applyLiveEvent` folds a
state change into the counts instantly; a debounced refetch reconciles. The
polling fallback is 30s (15s in the push view) and the badge says `polling`
when the stream is down.

`/v1/.../events/stream` writes an `: open` comment frame first. Without it a
resume (`?after=`) with nothing to replay sends no bytes until the first
heartbeat, so `EventSource.onopen` was late and the badge sat on "reconnecting".
Consumers must ignore comment frames (the CLI `--follow` parser and the test
helper `readSSEFrame` do).

## Design notes

- Colour is never the only signal: rings carry the percentage and an
  `aria-label`; milestones carry a glyph (▲ ● ◆) and text; the live badge has
  a glyph and a word.
- Big numerals are SVG `<text>` scaled by the viewBox, because `lint:design`
  allows only the type scale.
- Motion (`ship-in`, `chip-pop`, ring easing) is off under
  `prefers-reduced-motion`.
- A scrollable region with no focusable child needs `tabIndex={0}` (axe
  `scrollable-region-focusable`); `role="log"` replaces list semantics, so the
  `<ol>` sits inside the log `<div>`.
- Push view keys: `Esc` exit, `f` full screen, `1`/`2`/`3` window. `Shift+P`
  on the roadmap opens it.

## Screenshots

`docs/screenshots/roadmap-push/` — `before-*` and `after-*`, dark/light at
1440 and 390, for `/roadmap` and `/roadmap?push=1`. Reproduce with
`tools/e2e/scripts/seed-push.mjs` (fresh database) and `shoot-roadmap.mjs`.
