# Perf budgets (R10) — audit report

Measured 2026-10-09 on a workspace seeded with **10,000 issues** (+1 comment
per ~10 issues, ~14k events). Hardware: Apple M1 Max. Web served via
`next start` (production build), API in-process via `app.fetch` (handler +
Postgres, no TCP noise).

## Reproduce

```bash
docker compose up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tallyline_perf \
  npx tsx apps/api/scripts/seed.ts 10000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tallyline_perf \
  RATE_LIMIT_PER_MIN=100000 npx tsx apps/api/scripts/bench.ts
# web vitals (needs prod web on :3105 + api on :4000 against the seeded DB)
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tallyline_perf \
  E2E_WEB_PORT=3105 E2E_API_PORT=4000 \
  npx playwright test tests/perf.spec.ts -c tools/e2e/playwright.config.ts
node tools/e2e/scripts/bundle-budget.mjs   # after pnpm --filter web build
```

## API latency (declared budgets in `scripts/bench.ts`)

| Route | p50 | p95 | Budget | Result |
|---|---|---|---|---|
| list issues | 3.6ms | 5.9ms | 150ms | PASS |
| list issues (state filter) | 3.9ms | 5.9ms | 150ms | PASS |
| search issues | 7.0ms | 12.3ms | 250ms | PASS |
| issue detail + thread | 8.5ms | 12.2ms | 150ms | PASS |
| insights (26w event scan) | 69.0ms | 108.2ms | 800ms | PASS |
| activity feed | 2.0ms | 3.7ms | 200ms | PASS |
| create issue | 2.7ms | 3.8ms | 150ms | PASS |
| transition issue | 6.9ms | 10.5ms | 150ms | PASS |

Harness integrity: the bench refuses to run unless the workspace holds
≥10,000 issues, the detail route measures an issue that actually carries a
comment thread, every sample must return 2xx (a fast error is a failure,
not a fast route), and issues/events created during the run are deleted
afterwards so the fixture survives repeated runs.

## Web vitals (R10: LCP < 1.5s, INP < 200ms, CLS < 0.05)

| Page | settled (LCP bound) | FCP | INP | CLS |
|---|---|---|---|---|
| /issues | 691ms | 88ms | 24ms | 0.000 |
| /board | 627ms | 52ms | 16ms | 0.000 |
| /insights | 751ms | 136ms | 16ms | 0.000 |
| /roadmap | 638ms | 52ms | 16ms | 0.000 |

Headless Chromium on this platform does not emit `largest-contentful-paint`
entries, so the gate asserts on `settled`: the timestamp of the first
painted frame after `[data-qc-ready]` hydration AND `networkidle`. The
largest element can only paint once its data has arrived, so settled ≥ LCP
— passing settled < 1.5s implies LCP < 1.5s, and it honestly includes the
deferred `ssr:false` mounts that a `domComplete` bound would miss. If a
platform does emit LCP entries, the spec asserts the real value too.

INP is measured via `event`-timing + `first-input` entries on j/k
keypresses and a real click, after waiting for hydration. The spec requires
at least one timing sample per page — an unmeasured INP is a failure, not
a pass.

## Bundle (R10: initial JS < 200kb gzipped)

CI gate `tools/e2e/scripts/bundle-budget.mjs`: **128.9kb** shared initial
(limit 200), **724.0kb** all chunks (limit 750; was 600). The landing hero's
three.js chunk is the difference: it loads after idle on `/` only, is skipped
under reduced motion, and is not part of any app route or the initial budget.

Per-route script payload measured from served HTML: every route ≤196.4kb
gzipped. Before this audit, `/insights` shipped 302kb (recharts) and
`/board` 211kb (dnd-kit) — fixed via `next/dynamic` `ssr:false` loaders
(`insights-loader`, `board-loader`, `roadmap-loader`).

## List virtualization (R10: >100 rows)

`issue-list-client` rows carry `content-visibility: auto` +
`contain-intrinsic-size: 36px` — the browser skips layout/paint for
off-screen rows while keeping them in the DOM (j/k nav + find-in-page
unaffected). Pages fetch at most 200 rows, so native virtualization is the
right mechanism here; a JS windowing library earns its dependency cost only
if page size grows past ~1000.

## A11y floor (R11)

`tools/e2e/tests/a11y.spec.ts` axe-scans `/my-issues`, `/board`, `/triage`,
`/issues`, `/insights`, `/roadmap` in CI — clean at time of audit.
