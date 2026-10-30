# Railway one-click deploy

Config-as-code for the two app services plus the template recipe. The button
itself (a published Railway template) is an operator step; see "Publishing" below.

## What is here

- `api.json` / `web.json`: Railway config-as-code. Point each service's
  "Config as code file path" at its file. Build context is the repo root, so the
  Dockerfile paths are repo-relative. Healthchecks match `/health` (API) and `/` (web).
- This file: the variable contract the template must set.

## Template services and variables

| Service | Source | Variables |
|---|---|---|
| `Postgres` | Railway Postgres plugin | none (Railway provides `DATABASE_URL`) |
| `api` | this repo, `deploy/railway/api.json` | `NODE_ENV=production`, `API_PORT=4000`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `JWT_SECRET` (generated, 32+ chars), `AUTH_SECRET_KEY` (generated, 32+ chars, different from `JWT_SECRET`), `API_BASE_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}` of `api`, `WEB_URL=https://` + `web`'s public domain, `TRUSTED_PROXY=1` |
| `web` | this repo, `deploy/railway/web.json` | `NODE_ENV=production`, `API_INTERNAL_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4000`, build arg `NEXT_PUBLIC_API_URL=https://` + `api`'s public domain |

Only `web` and `api` need public domains. Open `https://<web domain>/bootstrap` to create the first admin.

## Publishing (operator, needs a Railway account)

1. Create a project with the three services above and the variables above
   (use the template variable generator for the two secrets).
2. In the project, "Create template from project", then copy the template URL.
3. Put the button in `README.md` and `docs/deploy.md`:
   `[![Deploy on Railway](https://railway.com/button.svg)](<template url>)`.
4. Verify by deploying the button into a scratch project, reaching `/bootstrap`, and deleting the project.

Written from Railway's config-as-code format as known when this was authored; check
the current template and variable-function docs at publish time (not verified against
the live Railway docs in this change).
