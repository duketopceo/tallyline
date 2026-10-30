# Contributing to tallyline

Thanks for helping build tallyline — a self-hostable, agent-native issue tracker where humans and AI agents work the same board. This document covers setup, the local quality gate, and the conventions that keep the repo consistent.

## Setup

Requirements: Node.js, pnpm 10, and Docker (for Postgres).

```bash
git clone https://github.com/duketopceo/tallyline
cd tallyline
pnpm install
cp .env.example .env
docker compose up -d   # Postgres on :5432
pnpm dev               # turbo dev — web + api + workers
```

Fill in `.env` values as needed for the integrations you are touching — the core app only needs `DATABASE_URL` (there is no `AUTH_SECRET` — it was a dead var; `JWT_SECRET` has a dev fallback, and `AUTH_SECRET_KEY`/OAuth vars are only needed when developing provider sign-in — see [docs/auth.md](./docs/auth.md)).

## The check gate

CI (`.github/workflows/check.yml`: static, unit, e2e, security) runs on every PR. Run the same gate locally first:

```bash
pnpm turbo run typecheck lint
pnpm turbo run test --filter='!@tallyline/e2e' --concurrency=1   # needs a throwaway DB, see below
```

## Testing against real Postgres

Tests run against a real Postgres database — do not mock the database layer. But **never point tests at the dev stack** from `docker-compose.yml` (Postgres `:5432`, db `tallyline`): several suites run migrations and wipe tables.

Every harness that touches the database (api, mcp-server, cli, e2e) runs a guard (`apps/api/test/db-guard.ts`) and refuses to start unless `DATABASE_URL` is explicitly set and are not the default dev stack. Use a throwaway stack on non-default ports:

```bash
docker run -d --rm --name tly-test-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=tallyline_test -p 127.0.0.1:55432:5432 postgres:17-alpine
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/tallyline_test
export JWT_SECRET=local-test-secret-0123456789abcdef
pnpm turbo run test --filter='!@tallyline/e2e' --concurrency=1
```

(`TALLYLINE_TEST_ALLOW_DEFAULT_DB=1` overrides the guard. Don't, unless the database really is disposable.)

The api suites clone a migrated template database per test file, so they never write to the database named in `DATABASE_URL` itself.

### e2e

`pnpm --filter @tallyline/e2e test` starts its own compose project (`tallyline-e2e`, `tools/e2e/docker-compose.e2e.yml`) with Postgres on `:55432` (override with `E2E_PG_PORT`), serves the API on `:4100` and web on `:3110` (`E2E_API_PORT` / `E2E_WEB_PORT`), and never reuses an already-running dev server. If `DATABASE_URL` is already set (as in CI) it uses that and starts nothing. Tear down with `pnpm --filter @tallyline/e2e stack:down`.

## Keep personal details out

This repository is public. Do not commit machine names, host aliases, private
network names, home-directory or temp paths, usernames, personal email
addresses, account or app IDs, or signing material. Describe machines by role
("the macOS build host", "the production host") and read anything
machine-specific from environment variables or repository secrets.

`tools/ci/privacy-scan.sh` runs in the check gate. It applies generic rules
(home and macOS temp paths, `.local` and tailnet host names, personal mail
domains) plus an owner-maintained term list in the `PRIVACY_DENYLIST` secret.
It prints only the file, line and rule, never the matched text. Note that git
history keeps anything committed before the scan existed.

## Conventions

- **TypeScript strict everywhere; no `any`.**
- **Conventional-commit PR titles.** Title every PR `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:` (etc.) — e.g. `feat: add issue activity feed`. Squash merge means the PR title becomes the commit message.
- **Merge policy:** all changes to `main` go through a pull request with at least one approving review. No direct pushes, no self-merge without review.

## Work orders

Larger pieces of work are tracked as **work orders** — GitHub issues using the *Work order* template, titled with a conventional-commit prefix (`feat:`, `fix:`, `chore:`), with two required sections:

- `## Acceptance criteria` — a checkbox list that defines done
- `## Blocked by` — dependencies on other issues, or `None`

If you are picking up work, look for issues labeled `work-order`. If you are proposing work, file it in that format so it is unambiguous when complete.

## License

tallyline's main app is licensed AGPL-3.0-only; the client and integration packages are MIT (see [LICENSING.md](./LICENSING.md)). There is no CLA and no DCO — by submitting a contribution you agree it is provided under the license that covers the path you changed. That's it.

## Conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). Report conduct issues to conduct@tallyline.app.
