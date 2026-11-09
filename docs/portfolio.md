# Portfolio overview

The page a client opens to see how their work is going. It is the landing page
after sign-in (`/overview`, `g o`, or Cmd+K "Go to Overview"). One row per
project in the workspace; a project is a repo's worth of tickets and roadmap.

## What each row shows

| Part | Source |
|---|---|
| Status, target date, on track / at risk / late | the project, with done over total issues |
| Progress bar and percent | done over total, canceled and duplicate excluded; 0% when a project has no issues |
| Ticket counts | open (triage, backlog, todo), in progress (in progress, in review), done |
| Milestones | completed over total, and the next unfinished milestone with its own progress and days left |
| Linked repos | repos bound to the project (see [github-sync.md](./github-sync.md)) |
| Recent activity | the last 5 issue events per project in the last 30 days: the action, who did it, the issue key |
| Error health | the cached GlitchTip count from [glitchtip.md](./glitchtip.md): open errors, or "last known" when the cache is stale or GlitchTip is failing |

Keyboard: `j`/`k` or the arrow keys move between rows, `Home`/`End` jump, `Enter`
opens the project. The totals strip above the list sums every project.

## API

`GET /v1/workspaces/:ws/portfolio` returns `{ projects: [...] }`. The page makes
this one request. Behind it the API runs a fixed set of queries (projects,
issue counts grouped by project and state, milestones with their linked-issue
progress, bound repos, recent events through one window query, and the GlitchTip
health read), so the cost does not grow with the number of projects. The
browser never calls GlitchTip; the error numbers are the cache the background
sync keeps.

- Every query is scoped by `workspace_id`; another workspace's slug is refused
  with `403 FORBIDDEN_WORKSPACE`.
- Activity rows carry the action, actor name, issue key and title. The event's
  `before` and `after` payloads are never returned.
- Milestones are capped at 8 per project in the response; `milestones.total`
  and `completed` still cover all of them.

## Who sees what

Visibility is the same as `GET /v1/workspaces/:ws/projects`: any member of the
workspace, and agent keys with read scope. The schema has no guest or client
role (roles are member, admin, owner), so the overview does not invent one. If a
narrower client role is added later, this endpoint is the one place to filter
projects.

## Moved

`/projects` redirects to `/overview`; `/projects/:id` is unchanged. The old
projects page fetched up to 200 issues per project from the browser; that path
is gone.
