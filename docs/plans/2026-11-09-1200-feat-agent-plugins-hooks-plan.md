---
title: Agent plugins and ticket hooks for every coding agent - Plan
type: feat
date: 2026-11-09
artifact_contract: ce-unified-plan/v1
product_contract_source: session-settled
execution: code
origin: session brief (owner-approved)
---

# Agent plugins and ticket hooks for every coding agent - Plan

## Goal Capsule

- **Objective:** Any coding agent (Claude Code, Codex, Devin, Cursor, Factory Droid, Gemini CLI) can install one Tallyline plugin, get the Tallyline MCP tools, and have its session announce/claim the ticket it is working and report progress on stop.
- **Means:** One plugin directory (`plugins/tallyline`) holds the single source of truth: `.mcp.json`, the skill, `hooks/`. Each vendor manifest is a thin pointer to it. Marketplace files at the repo root point at the plugin directory.
- **Stop:** No merge, no deploy (merging to `main` auto-deploys tallyline.app).

## Problem Frame

`plugins/tallyline` only supports Claude Code, and agents do not touch the board unless told to. Tallyline is the client-facing hub for tickets and repo roadmap progress (projects are repos), so session start and stop should update the board automatically, and never get in the agent's way.

## Requirements

- R1. Manifests for Claude, Codex, Devin, Cursor, Factory and Gemini plus Codex-style `.agents/plugins/marketplace.json`, mirroring `~/Documents/github/personal/agentflow`.
- R2. All manifests wrap the existing MCP server via one `.mcp.json`; no tool definitions in any manifest (tested).
- R3. Claude Code `hooks/hooks.json`: `SessionStart` claims the ticket, `Stop` updates status and links commit/PR. Ticket id from `TALLYLINE_ISSUE` env var, else branch name (`<KEY>-<n>`); none found means exit 0 silently.
- R4. Hooks fail soft: missing token/workspace, unreachable API, HTTP errors, bad stdin all exit 0 and never write to stdout in a way that blocks; hard timeout.
- R5. Auth via `TALLYLINE_TOKEN`/`TALLYLINE_WORKSPACE`/`TALLYLINE_API_URL`, falling back to the CLI config files (`~/.config/tallyline/config.json`, `./.tallyline/config.json`, `./.tallyline.json`). No secrets committed.
- R6. Document which vendors support hooks and which do not, with the manual equivalent.
- R7. Tests: manifest validation against each vendor's schema where one exists (Claude: published plugin/marketplace JSON schema shape; others: structural checks), single-source test, hook unit tests (claim, update, no-op, fail-soft).
- R8. Everything under `plugins/tallyline` stays MIT, dependency-free (node >= 20 stdlib only).

## Key Technical Decisions

- KTD1 (session-settled): manifests are pointers; `.mcp.json` is the only place the server launch is defined. Gemini requires inline `mcpServers`, so a test asserts it equals `.mcp.json`.
- KTD2: vendor manifests live in `plugins/tallyline/` (`.claude-plugin`, `.codex-plugin`, `.devin-plugin`, `.cursor-plugin`, `.factory-plugin`). Repo root keeps `.claude-plugin/marketplace.json` (exists), adds `.agents/plugins/marketplace.json` and `gemini-extension.json` (Gemini installs from the repo root; its context file is the existing root `SKILL.md`).
- KTD3: hook script is one dependency-free node ESM file `hooks/tallyline-hook.mjs` with `session-start` and `stop` subcommands and an exported pure-function core for tests.
- KTD4: claim = same semantics as MCP `claim` tool (assign to whoami identity; backlog->todo->in_progress; skip when already in_progress/in_review/terminal/triage). Stop = comment with commit sha and PR URL (from `gh pr view` when available) and move `in_progress` to `in_review` only when a PR URL exists. Agents never set done. Duplicate comments suppressed with a state file keyed by issue+sha.

## Implementation Units

- U1. Hook script + hooks.json + unit tests (`plugins/tallyline/hooks/`, `plugins/tallyline/tests/hook.test.mjs`), run with `node --test`.
- U2. Vendor manifests, root marketplace/gemini files, Claude plugin manifest updated to reference hooks and bump version; `.mcp.json` shared.
- U3. Manifest tests (`plugins/tallyline/tests/manifests.test.mjs`): JSON validity, required fields per vendor, single-source, paths exist, no secrets, MIT license.
- U4. Docs: plugin README (install per vendor, hook behavior, vendor hook-support matrix), LICENSING.md note, CHANGELOG, wire `node --test` into CI (`check.yml`).

## Risks

- Vendor schemas for Codex/Devin/Cursor/Factory/Gemini are not published as JSON Schema; tests encode the documented required fields and the agentflow reference shapes. Residual: not validated by the vendor CLIs.
- Merge to `main` deploys the web app; this change touches no deployed path, still not merged by the agent.
