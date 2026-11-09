# Tallyline plugin for coding agents

Bundles the Tallyline MCP server (`@tallyline/mcp-server`, launched with `npx`),
the `tallyline` agent skill and, for Claude Code, session hooks.

```
claude plugin marketplace add duketopceo/tallyline
claude plugin install tallyline@tallyline
```

Claude Code prompts for the API URL, workspace slug and an agent key
(`tly_agt_*`). The key is marked sensitive and kept in the system credential
store; nothing secret ships in this package.

The MCP entry runs `npx -y @tallyline/mcp-server`, so it works once that
package is published to npm (PLAN-019). Until then, override with a source
checkout, see `docs/mcp.md`.

`skills/tallyline/SKILL.md` is a copy of the repo-root `SKILL.md`; CI fails if
they drift.

## Other agents

One plugin directory serves every agent. Each vendor manifest is a pointer to
the same `.mcp.json` and `skills/`; no tool is defined twice.

| Agent | Manifest | Install |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json` | `claude plugin marketplace add duketopceo/tallyline` |
| Codex | `.codex-plugin/plugin.json`, `/.agents/plugins/marketplace.json` | add this repo as a Codex plugin marketplace |
| Devin | `.devin-plugin/plugin.json` | install from this repo |
| Cursor | `.cursor-plugin/plugin.json` | install from this repo |
| Factory Droid | `.factory-plugin/plugin.json` | install from this repo |
| Gemini CLI | `/gemini-extension.json` (repo root) | `gemini extensions install https://github.com/duketopceo/tallyline` |

Outside Claude Code, supply credentials through the environment:
`TALLYLINE_TOKEN`, `TALLYLINE_WORKSPACE` and optionally `TALLYLINE_API_URL`
(Gemini prompts for them as extension settings).

## Session hooks

`hooks/hooks.json` registers two Claude Code hooks that run
`hooks/tallyline-hook.mjs` (Node 20 or newer, no dependencies):

- **SessionStart**: finds the ticket id from `TALLYLINE_ISSUE`, else the branch
  name (`feat/kp-12-widget` gives `KP-12`). With no id, it does nothing. It
  claims the ticket the way the `claim` tool does (assign to the credential,
  move to `in_progress`), unless someone else holds it, and tells the agent
  what it did.
- **Stop** (fires after each turn): when HEAD moved since the session began,
  it comments the commit; when a pull request exists (via `gh`), it adds the
  link and moves an `in_progress` ticket to `in_review`. Agents never mark
  tickets done. The same commit and PR are reported once.

Credentials come from the environment, else the CLI config files
(`~/.config/tallyline/config.json`, `./.tallyline/config.json`,
`./.tallyline.json`). Keychain-stored tokens are not read; export
`TALLYLINE_TOKEN` for the hooks.

The hooks fail soft: no id, no token, an unreachable API, an HTTP error or bad
input all exit 0 with no output, and each request has a 5 second limit. A
branch name that happens to look like a key (for example `fix/utf-8`) just
produces a failed lookup and no change.

### Which agents run the hooks

| Agent | Hooks | Notes |
|---|---|---|
| Claude Code | Yes | `hooks/hooks.json`, loaded with the plugin |
| Codex, Cursor, Factory Droid, Devin, Gemini CLI | Not wired | Their plugin formats either lack a plugin-bundled hook slot or use a different hook schema that this repo has not verified. Use the MCP tools through the skill, or call the script yourself from the agent's own hook setting: `node hooks/tallyline-hook.mjs session-start` and `... stop`, with the JSON the agent supplies on stdin (`session_id`, `cwd`) |

## Tests

`node --test plugins/tallyline/tests/` validates every manifest (including
`claude plugin validate --strict` when the CLI is installed) and unit-tests
the hook script's claim, update and no-op paths.
