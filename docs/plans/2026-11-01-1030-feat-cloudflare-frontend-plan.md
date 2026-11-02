---
title: Cloudflare-Hosted Web Front End - Plan
type: feat
date: 2026-11-01
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
origin: docs/deploy.md
---

# Cloudflare-Hosted Web Front End - Plan

## Goal Capsule

- **Objective:** `apps/web` can run on Cloudflare Workers through OpenNext (`@opennextjs/cloudflare`) while the API and Postgres stay on the home server behind the existing Cloudflare Tunnel. Workers is an optional deploy target. The compose path that other self-hosters use does not change.
- **Why:** today the whole site, including the shell, goes down with the home server. On Workers the shell, static assets and a branded "API unreachable" state survive an outage, previews can be built per PR, and the web container leaves the home server.
- **Authority:** `AGENTS.md` and `DESIGN.md` win over this file. This plan does not move the API or database.
- **Stop conditions:** if S1 measurements show the Worker is clearly slower than the compose web tier on the main pages and a fix needs more than one reviewable PR, stop after S1 and keep S0 only.
- **Ship:** S0 ships with this PR. S1 to S3 are separate PRs. Cutover (S2) is Luke's call.

## Current state

- Compose runs `apps/web` (Next.js, `next start`), `apps/api` (Hono) and Postgres. A Cloudflare Tunnel serves the web app and the API on two hostnames of one zone.
- The browser only talks to the web origin. `apps/web/app/api/**` are server-side bridges that attach the session cookie and call the API using `API_INTERNAL_URL`, the compose service URL.
- Per-request CSP nonces make every page dynamic (`export const dynamic = "force-dynamic"` in the root layout).

## Spike findings

A throwaway spike on `main` (Next.js 16.4.2, `@opennextjs/cloudflare` 1.20.15, Wrangler 4.156.0, compatibility date 2026-10-30) with only a `wrangler.jsonc` and `open-next.config.ts` added, no source changes:

- `opennextjs-cloudflare build` succeeded. The existing `middleware.ts` (edge runtime) bundled. Next warns that the `middleware` convention is deprecated in favour of `proxy`.
- Worker bundle: 9.3 MiB uncompressed, 1.65 MiB gzip. Static assets: 2.9 MB in 123 files. The size limit is 64 MiB uncompressed on both plans, so size is not a constraint.
- Under `wrangler dev` against a mock API these worked unchanged: the landing page, `/login` (CSP header with a fresh nonce), the session gate redirect (`/my-issues` to `/login`), `/status` reading the API health, `/api/auth/methods` (`node:crypto` plus cookie set), the cross-site `POST` refusal (403), and the SSE bridge streaming through.
- `API_INTERNAL_URL` set as a Worker variable was read through `process.env` as the code expects.
- Client-IP forwarding is not equivalent. `lib/upstream.ts` forwards `cf-connecting-ip` and `x-forwarded-for`, but the runtime dropped `cf-connecting-ip` on the outgoing call and only `x-forwarded-for` arrived (see B2).
- `/_next/image` returns 404 because no images binding is configured. Nothing uses `next/image`, so this is fine.

Not verified by the spike: a deployed Worker, real tunnel latency, OAuth round trips, the production API.

## Audit of `apps/web`

| Area | Finding | Verdict |
|---|---|---|
| Server bridges | 82 route handlers under `app/api/**`, all via `lib/proxy.ts`, `lib/public-proxy.ts` or direct `upstreamFetch`, all using `API_URL = API_INTERNAL_URL ?? NEXT_PUBLIC_API_URL`. None set `runtime = "edge"`. | Works on the Node runtime of OpenNext. Needs `API_INTERNAL_URL` pointed at something a Worker can reach (B1). |
| Server actions | None (`"use server"` does not appear). | No blocker. |
| Image optimisation | No `next/image` usage, no `images` config. | Leave unconfigured. |
| Node APIs | One import: `node:crypto` `randomBytes` in `app/api/auth/methods/route.ts`. Middleware uses `crypto.randomUUID` and `btoa`. | Supported with `nodejs_compat`. |
| Env vars | `NEXT_PUBLIC_API_URL` is inlined at build into the client bundle and the middleware CSP `connect-src`, the OAuth `startUrl`, and `app/(auth)/link/page.tsx`. `API_INTERNAL_URL` and `WEB_URL` are read at runtime. | Needs a Workers-specific build with the public API origin (B3). Runtime vars become Worker vars. |
| Auth cookies | `tly_session`, `tly_ws`, `tly_login_nonce` and the appearance cookie are set by the web route handlers on the web origin (host-only, `HttpOnly`, `SameSite=Lax`). The browser never sends cookies to the API hostname. | No change. A deployed Worker emits the same `Set-Cookie`. Existing sessions keep working at cutover because the cookie host does not change. |
| CORS | The browser only calls same-origin `/api/*`. The API has CORS only on the MCP OAuth endpoints. The bridge `Origin` check compares against `Host` / `x-forwarded-host`, and a Worker sees the public host. | No change. |
| Redirects | `middlewareRedirect` builds absolute URLs from the `Host` header. | Works on a custom domain. On a `workers.dev` preview it uses the preview host, which is correct. |
| Caching | The root layout is `force-dynamic` because of nonces, so no HTML is cacheable, there is no ISR and no `use cache`. | No R2 incremental cache needed. S3 is mostly static assets. |
| Middleware | `middleware.ts` is edge runtime and works. Next 16 deprecates it. OpenNext supports the Node-runtime `proxy.ts` only experimentally. | Keep `middleware.ts`. Revisit if Next removes it (R3). |
| Streaming | `app/api/events/stream` pipes an upstream event stream. Works in the spike. Workers has no wall-clock limit while the client is connected. | Verify with the real API in S1 (R4). |
| Bundle budget | `tools/e2e/scripts/bundle-budget.mjs` reads `.next`. | Unaffected. |

### Blockers and risks, ranked

| # | Item | Impact | Resolution | Stage |
|---|---|---|---|---|
| B1 | **Every server render now crosses the WAN to the API.** Today SSR calls the API over the compose network. On Workers each `api()` call goes edge to tunnel to the home server, and pages that make several calls in sequence pay that per call. | Slower pages, the main reason not to do this. | Set `API_INTERNAL_URL` to the public API hostname. Enable Smart Placement so the Worker runs near the API. Run independent `api()` calls in parallel on the slowest pages. Decide on measured numbers. | S1 measure, S3 tune |
| B2 | **Client IP for rate limits.** The API reads `CF-Connecting-IP`, then the last `X-Forwarded-For` hop (`apps/api/src/lib/rate-limit.ts`). From a Worker, `cf-connecting-ip` is not forwarded. For a same-zone subrequest Cloudflare derives it from `x-real-ip`. Cross-zone it is replaced with an internal address. | All users share one anonymous rate-limit bucket. | In `lib/upstream.ts`, also send `x-real-ip` with the visitor address from `cf-connecting-ip`. Test it and check the API logs the real address. Requires `TRUSTED_PROXY=1` on the API, which a tunnel deployment already needs. | S1 |
| B3 | **`NEXT_PUBLIC_API_URL` baked at build.** | A Workers build must be made with the public API origin. Wrong value breaks CSP and OAuth start links. | The CI job builds with the public API origin as an explicit variable. Self-host builds are untouched. | S1 |
| B4 | **Workers Free CPU limit is 10 ms per request.** Next.js SSR typically needs more. | Errors (1102) on the free plan. | Use Workers Paid. Confirm CPU time from Workers Logs in S1. | S1 |
| B5 | **Same-zone Worker-to-Worker `fetch()` fails.** If the offline Worker (S0) is routed on the API hostname, a web Worker calling that hostname fails. | Cutover breakage. | Keep the offline Worker off the API hostname (the default in this PR), or call the API through a service binding or Workers VPC. | S2 |
| B6 | **Previews and OAuth.** The API redirects to `WEB_URL` after OAuth, so a `workers.dev` preview cannot finish an OAuth login. A preview that points at the production API acts on production data. | Surprising previews. | Previews use password login and a throwaway account, or point at a staging API. Document it. Fork PRs get no secrets and no preview. | S1 |
| B7 | **API unreachable inside the Worker.** `api()` throws when the API is down, which shows the generic Next error page. | Ugly degraded state, the thing S0 fixes for the proxy path. | Map upstream failure to the same offline content from `error.tsx`, with `Retry-After` on the page. | S2 |
| R1 | Two build outputs from one source. | Drift. | CI builds both on every PR touching `apps/web` or `packages/**`. | S1 |
| R2 | New dev dependencies (`@opennextjs/cloudflare`, `wrangler`). | Self-host image bloat if added as dependencies. | Add as `devDependencies` of `apps/web` so `pnpm deploy --prod` in the Dockerfile skips them. Do not import them from `next.config.ts`, because `next start` in the image would not find them. | S1 |
| R3 | OpenNext and Next move fast, and `middleware.ts` is deprecated. | Upgrades break the Workers build. | Pin exact versions. The CI build is the early warning. Reassess `proxy.ts` support before upgrading Next past the next minor. | ongoing |
| R4 | SSE bridge behaviour on a deployed Worker (idle timeouts, six-connection limit per request). | Dropped live updates. | Test a long-lived stream against the real API in S1. The client already reconnects with `Last-Event-ID`. | S1 |

The Cloudflare guide now recommends vinext for new Next.js projects, and says to keep existing OpenNext setups. This app is existing, the OpenNext spike built and ran with no source change, and OpenNext was the stated choice, so this plan uses OpenNext. Revisit vinext only if OpenNext lags behind Next.

## Architecture

```
today      browser -> Cloudflare -> tunnel -> web (home) -> api (home)
S0         browser -> Cloudflare -> offline Worker -> tunnel -> web (home) -> api (home)
S2         browser -> Cloudflare -> web Worker -> api hostname -> tunnel -> api (home)
```

Cookies stay on the web hostname. The API stays on its own hostname and the browser still never calls it with credentials, apart from the OAuth start redirect that already exists.

## Stages

### S0: offline page (in this PR)

- `deploy/cloudflare/offline-worker/`: a pass-through Worker with `wrangler.jsonc`, `src/`, and unit tests (`pnpm --filter @tallyline/offline-worker test`).
- Serves a branded `503` page with `Retry-After` when the origin answers 520-530, a non-JSON 502/503/504, errors, or does not answer headers within the timeout. Passes everything else through, including app-sent JSON errors and streams.
- `docs/deploy.md` has the enabling steps. CI does not deploy it. Luke enables it.
- **Verify:** stop the tunnel, request the site with `accept: text/html`, expect `503`, `retry-after` and `x-tallyline-offline: 1`. Start the tunnel and expect normal pages.
- **Rollback:** delete the route or the Worker. Nothing else depends on it.

### S1: OpenNext build in CI and a preview

Deliverables (separate PR):

- `apps/web`: `@opennextjs/cloudflare` and `wrangler` as exact-version `devDependencies`, `wrangler.jsonc` (name `tallyline-web`, `nodejs_compat`, `global_fetch_strictly_public`, static assets binding, `observability` with traces, Smart Placement, no routes), `open-next.config.ts`, `public/_headers` (immutable `/_next/static/*`), and scripts `cf:build`, `cf:preview`, `cf:deploy`. `next.config.ts` is not touched.
- Fix B2 in `lib/upstream.ts` with a unit test.
- CI job `cloudflare-web` on PRs that touch `apps/web` or `packages/**`: build with `NEXT_PUBLIC_API_URL` set to the public API origin, `wrangler deploy --dry-run` with a size report, then a smoke script against `wrangler dev` with a mock API covering the checks from the spike (gate redirect, `/login` nonce CSP, `/status`, `/api/auth/methods` cookie, cross-site `POST` 403, SSE through the bridge, client IP header reaching the API).
- Preview upload (`wrangler versions upload`) only for same-repo PRs with the Cloudflare token secret. Luke creates the empty `tallyline-web` Worker once.
- `docs/deploy.md`: an optional "Cloudflare Workers front end" section, including what to set (`API_INTERNAL_URL`, `WEB_URL`, build-time `NEXT_PUBLIC_API_URL`, `TRUSTED_PROXY=1` on the API).
- **Measure (the gate for S2):** time to first byte for `/login`, `/my-issues`, an issue page and `/board`, from the preview and from the compose web tier, 20 runs each at two times of day. Record the table in this plan. Check CPU time per request in Workers Logs against B4. Hold a live event stream open for 10 minutes against the real API.
- **Exit:** the preview loads, password login works, the board streams live updates, the numbers are recorded, and the compose build and e2e job are unchanged and green.

### S2: cutover with rollback

Preconditions: S1 exit met, Workers Paid enabled, B2 merged, Luke has read the numbers.

1. Deploy `tallyline-web` with a `workers.dev` URL only and `API_INTERNAL_URL` set to the public API hostname. Smoke it.
2. Add B7: API failure renders the offline content with `Retry-After` instead of the error page.
3. Swap the web route. Remove the offline Worker route from the web hostname (one Worker per route) and attach `tallyline-web` to it. The tunnel ingress and the compose `web` container stay up and untouched.
4. Soak for at least seven days. Watch Workers error rate, CPU time, API rate-limit logs (real client addresses), and the e2e smoke against production.
5. **Rollback (under a minute):** remove the `tallyline-web` route and re-add the offline Worker route. Traffic returns to the home web container, which was never stopped. No data migration is involved and sessions survive because the cookie host does not change.
6. After the soak, keep the compose `web` service in `docker-compose.selfhost.yml` for self-hosters. Luke may stop only his own copy.

### S3: caching and tuning

Kept small on purpose, because HTML cannot be cached while CSP uses per-request nonces.

- Confirm `/_next/static/*` is served immutable from the assets binding (added in S1).
- Parallelise sequential `api()` calls on the pages the S1 numbers flag. Re-evaluate Smart Placement with real data.
- Optional: serve the public pages (landing, legal) as static with hash-based CSP if the numbers justify the extra moving part. Not planned otherwise.
- Not planned: an R2 incremental cache (no ISR, no `use cache`), Workers KV, or caching authenticated API reads at the edge.

## Self-host compatibility

- `Dockerfile`, `docker-compose.yml`, `docker-compose.selfhost.yml`, `ops/deploy.sh` and `next.config.ts` do not change. Workers is a second, opt-in target.
- OpenNext and Wrangler are dev dependencies, so the production image does not carry them.
- Nothing in app code may import from `@opennextjs/cloudflare` or `cloudflare:*`. All Workers specifics live in config files.
- CI keeps the existing `next build`, the e2e job and the bundle budget as they are, and adds the Workers build beside them.

## Decisions for Luke

1. **API reachability from the Worker.** Recommended first: the public API hostname through the tunnel (already works, no new product). Later hardening option: a Workers VPC service over the same tunnel (the binding is in beta) so the API hostname can be closed to the public.
2. **Workers Paid** is needed for S2 (B4). The offline Worker fits on the free plan.
3. **Preview data policy** (B6): throwaway account on production, or a staging API.
4. **Offline Worker after S2:** retire it, or keep it only on the API hostname if nothing on the same zone calls that hostname from a Worker (B5).

## Verification

- S0: the Worker's unit tests, type check, lint, a `wrangler deploy --dry-run`, a local `wrangler dev` run against a stub origin, and the manual tunnel-stop check above.
- S1 to S3: each stage's exit criteria above. A stage is not done until the compose path is shown unchanged.
