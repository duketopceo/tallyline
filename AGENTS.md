# AGENTS.md — tallyline

> This file is the agent entry point for this repo.
> Full agent context lives at: https://github.com/duketopceo/luke-agents

## What This Repo Does

tallyline is an open-source (AGPL-3.0, with MIT client packages; see LICENSING.md), self-hostable, agent-native issue tracker — a Linear-class product where humans and AI agents are first-class citizens on the same board. It is a TypeScript monorepo: a Next.js web app, a Hono + Postgres (Drizzle) API, an MCP server that exposes the tracker to AI agents, a CLI, and shared packages for types and the silver-lining design system. Agent dispatch lives in the API (`apps/api/src/services/dispatch.ts`), not a separate worker. pnpm workspaces + Turborepo orchestrate the monorepo; Docker Compose provides Postgres for development and self-hosting.

## Key Files

- `apps/web` — Next.js App Router web app (Tailwind + shadcn/ui + cmdk)
- `apps/api` — Node + Hono API server, Postgres via Drizzle (includes agent dispatch)
- `apps/mcp-server` — MCP server exposing tallyline to AI agents
- `tools/cli` — `tallyline` CLI
- `packages/types` — shared TypeScript types
- `packages/silver-lining` — design tokens and UI primitives
- `docker-compose.yml` — Postgres for dev and self-host
- `plans/` — implementation plans
- `docs/` — documentation
- `ROADMAP.md` — pointer to the full status ledger

## Current Status

- [ ] In development
- [ ] Deployed
- [ ] Production traffic

## Active Issues / Known State

## Agent Instructions (repo-specific)

- Main app is AGPL-3.0-only; `apps/mcp-server`, `tools/cli`, `integrations/n8n`, `integrations/composio` and `plugins/tallyline` stay MIT (see LICENSING.md). Never copy code from Plane, Tegon or Huly (study material only), and keep copyleft code out of the MIT packages.
- DESIGN.md is the design contract — treat it as the source of truth for product decisions.
- TypeScript strict everywhere; no `any`.
- Every UI follows UX-first rules in the AGENTS.md lineage — Cmd+K palette, keyboard nav, density.
- Use conventional-commit titles.
- luke-agents precedence: where this file and https://github.com/duketopceo/luke-agents disagree, luke-agents wins.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
