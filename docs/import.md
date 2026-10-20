# Plan import

`POST /v1/workspaces/:ws/import/plan` turns a ce-plan markdown file into issues in one project. It is safe to re-run: a second run reports everything unchanged. The CLI and MCP tool wrap it; see [CLI and MCP](#cli-and-mcp) below.

## Flow

1. Send the plan with `mode: "dry_run"` (the default). Nothing is written. The response is a diff and a `diffHash`.
2. Read the diff. Fix anything `ambiguous` by sending `resolutions`.
3. Send the same body with `mode: "apply"` and the `diffHash`. The service recomputes the diff inside a transaction. If it differs from the one you reviewed (the plan, the evidence, the resolutions, or the workspace changed, for example through GitHub sync), it writes nothing and returns `409 STALE_DIFF` with the new diff. Review it and apply again with the new hash.

Apply is one transaction per plan, takes a workspace advisory lock and one per plan file (imports in a workspace run one at a time), and writes one event per issue.

## CLI and MCP

CLI, dry run first (the default; nothing is written):

```sh
tallyline import-plan docs/plans/2026-10-15-kate-production-launch-plan.md --project Kate --scope KP
```

It prints the counts, every unit that is not unchanged (ambiguous ones with their candidates), and a `diffHash`. Read it, then apply that exact diff:

```sh
tallyline import-plan <same path and flags> --apply --diff-hash <hash>
```

`--apply` without `--diff-hash` runs the dry run, prints it, writes nothing and exits 2. A `STALE_DIFF` prints the new diff and exits 5. `--resolutions f.json` maps `KP-U12` to an issue key, or to `"new"`. `--json` prints the raw diff.

The CLI reads the plan itself, so the API never needs repo credentials. For a local file it takes the repo from `origin`, the path from the git root and the sha from `HEAD`; for an https github `blob` or `raw` url it fetches the raw file and takes all three from the url (the ref must be a commit sha). Override with `--repo`, `--source-path` and `--sha`. `--scope` is always required.

`--evidence f.json --historical` writes done and in-progress state for merged units. It works only with a human owner or admin token; an agent key gets `403 FORBIDDEN_HISTORICAL`.

MCP: the `import_plan` tool takes the same fields (`markdown` instead of a path, plus `repo`, `path`, `sha`), `mode` defaulting to `dry_run`, and `diffHash` for apply. It has no `evidence` or `historical` input. `create_project` and `update_project` make the target project; names are unique case-insensitively. A key with only `read` scope is refused (`FORBIDDEN_SCOPE`), dry run included, because the route is a POST.

## Request

| Field | Meaning |
|---|---|
| `project` | Project id or exact name. Another workspace's project is 404. |
| `teamKey` | Team for new issues. Defaults to the project's team, then the workspace's first team. |
| `plan.scope` | Title namespace, 1-8 characters of `A-Z0-9`, such as `KP`. |
| `plan.source` | `{ repo, path, sha, url? }`. `url` must be https. Recorded on every issue; `repo:path` keys the dedupe refs. |
| `plan.markdown` | The plan text. The client fetches remote plans; the API never needs repo credentials. |
| `evidence` | Map of unit id (`U12`) to `{ state?, prs?, mergedAt? }`, up to 200 entries. PR urls are built from `repo` and `number`. |
| `historical` | Allow `evidence` states `in_progress` and `done`. |
| `resolutions` | Map of scoped unit id (`KP-U12`) to an existing issue key, or to `"new"` to create the unit when every candidate is unrelated, up to 200 entries. Two units may not resolve to the same issue (`422 DUPLICATE_MATCH`). |
| `mode`, `diffHash` | `dry_run` or `apply`, and the reviewed hash. |

A plan may hold up to 200 units; more is `422 PLAN_TOO_LARGE`. The request body is limited to 2MB (`413`). The parser reads at most 100,000 lines of 2,000 characters.

## What the parser reads

`### U<N>. Title` headings (level 3 or 4), outside code fences. Per unit: the Goal, Dependencies, Files and Verification labels, either `**Goal:**` or `- **Goal:**`. A unit with no Goal label uses its first paragraph. Dependencies come from the label, or from a `Depends on` column in an overview table when there is no label; ranges such as `U1-U4` expand. GitHub issue URLs and `owner/repo#N` references in a unit body are used for matching. Phases come from `Phase A` style headings and from a table with `Phase` and `Units` columns. A numbered list under a "Luke actions" heading is parsed too, but this endpoint does not import it.

A unit with no title or a repeated id is reported as `invalid`; the other units still import.

## Titles and descriptions

Each unit becomes `[SCOPE-U<N>] title`. The scope keeps two plans that both number their units U1 to U13 apart. The body holds the Goal, the Verification, a `Depends on:` line (relations replace it once they exist) and a footer naming the source, short sha and unit. Phases become project milestones (reused by title on the next run); linking issues to milestones and the `hitl` label wait for the milestone-link unit.

## Matching, in order

1. **Plan ref.** A `plan` external ref with id `<repo>:<path>:<unit id>`, written by an earlier apply. This is how a re-run finds its issues.
2. **Resolution.** A `resolutions` entry for the unit. `"new"` skips layers 3 to 5 and creates the issue.
3. **Scoped id in a title.** `[KP-U12]` anywhere in an existing title. A bare `U12` in a title is ambiguous unless the issue's description names the plan path, in which case it is a match.
4. **GitHub link.** A GitHub issue the unit names, already linked through GitHub sync. The issue is matched and assigned to the project, not duplicated.
5. **Title similarity.** `pg_trgm` similarity of 0.85 or more on normalized titles (bracket prefixes removed, punctuation folded). Reported as `ambiguous`, never merged.

Layers 2 to 4 adopt an existing issue: apply adds the `plan` ref and sets the project if it has none, and leaves the title and description alone. Only an issue the import wrote follows later changes of the unit title and body, and only while its title and description still match the hash stored on its `plan` ref at the last write. If someone edited it, the diff warns and leaves the text alone; state, project and PR links still update. An issue that already belongs to another project is never moved; the diff warns.

A resolved pair is stored as a `plan` ref, so the next dry run matches it at layer 1 and reports it unchanged.

## Diff

`counts` and `units[]` with an `action` per unit: `create`, `update` (with `changes`: `title`, `description`, `project`, `state`, `ref`, `pr_links`), `unchanged`, `ambiguous` (with `candidates` and a reason) or `invalid`. Also `milestones.create` and `milestones.existing`, and `warnings`.

## Historical state and evidence

Agents cannot move an issue from `in_review` to `done`, and an import does not change that. Writing an issue directly as `in_progress` or `done` is a separate, human decision:

- It needs `historical: true` and a human owner or admin credential. An agent key, or a member, gets `403 FORBIDDEN_HISTORICAL`, including when only `evidence` carries the state, a PR list or a `mergedAt`. A `mergedAt` in the future is `422 INVALID_EVIDENCE`.
- Without `historical`, `evidence` states other than `backlog` and `todo` are ignored and the diff warns.
- A new issue gets the evidence state. An existing issue moves forward only (never from `done` back to `todo`), and `canceled` and `duplicate` issues are not touched.
- Such an issue gets one `imported` event with the state, the PR list and `mergedAt`; the event is dated at the merge date. Every other new issue gets the normal `created` event.
- `prs` become `github_pr` refs with id `<owner>/<repo>#<n>:<issue key>`.

Insights read `created` and `state_changed` events, so a historical `done` does not appear as a completion in the cumulative flow.

## Errors

| Status | Code | When |
|---|---|---|
| 400 | `DIFF_HASH_REQUIRED` | apply without a hash |
| 403 | `FORBIDDEN_HISTORICAL` | historical state without a human owner or admin credential |
| 404 | `NOT_FOUND` | project or team not found in this workspace |
| 409 | `STALE_DIFF` | the diff changed since the reviewed dry run; body has `diff` |
| 413 | `PAYLOAD_TOO_LARGE` | body over 2MB |
| 422 | `NO_UNITS`, `PLAN_TOO_LARGE`, `UNKNOWN_RESOLUTION`, `DUPLICATE_MATCH`, `INVALID_EVIDENCE` | |
