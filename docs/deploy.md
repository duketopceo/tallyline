# Self-hosting tallyline

Three paths, fastest first. All of them land on the same thing: the web
app on port `3100`, the API on `4000`, postgres on an internal
network. Open `http://localhost:3100` — the first-run **/bootstrap** page
creates your workspace, team, and admin user, then you're on the board.

## Quickstart — Docker Compose (target: < 10 min)

```bash
git clone https://github.com/duketopceo/tallyline.git && cd tallyline

# required: a db password and a JWT secret
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
EOF

docker compose -f docker-compose.selfhost.yml up -d
# first build ~4-6 min on a warm connection; then:
# → http://localhost:3100  → bootstrap → board
```

That's it — `docker-compose.selfhost.yml` builds `apps/api` and `apps/web`
from source, runs Drizzle migrations on API boot, and waits for healthy
postgres before starting the app. Only `web:3100` and `api:4000` are
published; the datastores stay internal. Override published ports with
`WEB_PUBLISH_PORT` / `API_PUBLISH_PORT`.

The dev `docker-compose.yml` (postgres only, host-mapped ports) is
unchanged — contributors keep using `docker compose up -d` + `pnpm dev`.

## Environment reference

Set these in `.env` next to the compose file (it reads `.env` automatically):

| Var | Required | Default | Purpose |
|---|---|---|---|
| `POSTGRES_PASSWORD` | **yes** | — | Password for the internal postgres |
| `POSTGRES_USER` / `POSTGRES_DB` | no | `postgres` / `tallyline` | Credentials/db name |
| `JWT_SECRET` | **yes** | — | Signs short-lived access JWTs — `openssl rand -hex 32`. With `NODE_ENV=production` the API **refuses to start** if it is unset, empty, under 32 chars, or a known dev default |
| `API_BASE_URL` | no | `http://localhost:4000` | Public API origin — used in the GitHub App manifest + Slack/CLI callbacks. Set to your real hostname when fronting with a tunnel |
| `API_PORT` | no | `4000` | Port the API binds *inside* its container — only change together with the compose `environment`/`API_INTERNAL_URL` |
| `NEXT_PUBLIC_API_URL` | no | `http://localhost:4000` | Fallback API origin baked into the web build; server-side bridges prefer `API_INTERNAL_URL` |
| `API_INTERNAL_URL` | no | `http://api:4000` (in compose) | Where the web service's bridge routes reach the API — service-name URL inside the compose network; set it in `.env` only for exotic topologies |
| `API_PUBLISH_PORT` / `WEB_PUBLISH_PORT` | no | `4000` / `3100` | Host ports the services bind |
| `RATE_LIMIT_PER_MIN` | no | `600` | Authenticated requests/minute per token/session (`0` disables — don't, on public instances) |
| `AGENT_KEY_DEFAULT_EXPIRY_DAYS` | no | `90` | Expiry applied to a newly minted or rotated agent key when the caller gives none (`0` = never expire by default) |
| `RATE_LIMIT_ANON_PER_MIN` | no | `120` | **New.** Unauthenticated requests (and failed-credential attempts) per client IP, counted before auth. `/health` and signed provider webhooks are exempt. Needs `TRUSTED_PROXY=1` behind a proxy/Cloudflare or every visitor shares one bucket |
| `RATE_LIMIT_AUTH_PER_MIN` | no | `30` | **New.** Login, bootstrap, invite-accept and OAuth start/callback per client IP |
| `DISPATCH_ACK_TIMEOUT_MS` | no | `600000` | **New.** A dispatch still `queued` after this window is failed loudly on the issue thread (delivery wedged without writeback). Keep above the ~7.5 min webhook retry budget. `0` disables |
| `DATABASE_URL` | no | compose-internal | Override only for an external Postgres |
| `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET` | no | — | GitHub App sync — see [github-sync.md](./github-sync.md); all empty = feature off |
| `WEB_URL` | no | `http://localhost:3100` | Public web origin — OAuth callbacks bounce here after exchange; set to your real web hostname behind a tunnel |
| `AUTH_SECRET_KEY` | for DB providers | — | AES-256-GCM key (`openssl rand -base64 32`; in production must be ≥32 chars when set and differ from `JWT_SECRET`) encrypting provider secrets stored via the UI. Losing/rotating strands them — see [auth.md](./auth.md) |
| `MAIL_TRANSPORT` | no | `log` | `log`/`smtp`/`cloudflare` — how reset and verification mail is sent (`SMTP_URL`, or `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN`). `log` prints each message, links included, to the server log only; use it for local dev and treat the log as sensitive. With `log` outside production, instance admins can read captured mail at `GET /v1/dev/mail`; with `NODE_ENV=production` that endpoint is always `404` (for admins too) and nothing is kept in memory, so production on `log` means links are readable only in the log |
| `AUTH_ADMIN_EMAILS` | no | bootstrap owner | Comma-separated instance admins (provider CRUD). Unset → the bootstrap workspace owner is the fallback admin |
| `AUTH_DISABLE_PASSWORD` | no | off | `1` = SSO-only — hides password login, `PASSWORD_DISABLED` on mint routes |
| `AUTH_ACCOUNT_LINKING` | no | `auto` | `auto`/`login`/`disabled` — verified-email match links silently, requires proof, or never links |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | no | any | Comma-separated JIT allowlist; invites bypass it |
| `AUTH_AUTO_JOIN_SINGLE_WORKSPACE` | no | **off** | **Default changed from on.** `1` lets new OAuth users auto-join when the instance has one workspace — open membership, only for private installs |
| `TALLYLINE_ALLOW_WORKSPACE_CREATE` | no | off | **New.** Off: only instance admins can `POST /v1/workspaces`. `1`: any signed-in human can (self-serve orgs on a shared install) |
| `TALLYLINE_WEBHOOK_ALLOW_PRIVATE` | no | off | **New.** Off: webhook/agent-dispatch URLs resolving to private, loopback, link-local, CGNAT, ULA or metadata addresses are rejected (at save and at delivery; redirects are not followed). `1` for self-hosters delivering to LAN services |
| `TRUSTED_PROXY` | no | off | `1` trusts `CF-Connecting-IP`, then the last `X-Forwarded-For` hop, for rate limits, and `X-Forwarded-Proto` for HSTS/`Secure` cookies — only behind Cloudflare or a real reverse proxy that overwrites them |
| `GITHUB_CLIENT_ID`/`_SECRET` | no | — | "Sign in with GitHub" — the App's OAuth credentials double as the provider's (see [auth.md](./auth.md)) |
| `GOOGLE_CLIENT_ID`/`_SECRET` | no | — | "Sign in with Google" — callback `{API_BASE_URL}/v1/auth/oauth/google/callback` |
| `OIDC_ISSUER`/`_CLIENT_ID`/`_CLIENT_SECRET`/`_DISPLAY_NAME`/`_SCOPES` | no | — | Generic OIDC via discovery — `{issuer}/.well-known/openid-configuration` |
| `SLACK_*` | no | — | Slack intake/mirroring — see [slack.md](./slack.md); empty tokens = off |
| `TALLYLINE_LLM_*` | no | — | LLM assist (OpenRouter or any OpenAI-compatible endpoint) — see [llm-assist.md](./llm-assist.md); empty key = off |
| `COMPOSIO_API_KEY`, `LINEAR_API_KEY` | no | — | Optional integration credentials |
| `AUTH_SECRET` | — | — | **removed** — legacy var older `.env` files may still carry; nothing reads it. `JWT_SECRET` is the live secret |

**MCP endpoint (optional `--profile mcp` service):**

| Var | Required | Default | Purpose |
|---|---|---|---|
| `MCP_PUBLISH_PORT` | no | `3101` | Host port for the hosted-MCP endpoint |
| `TALLYLINE_MCP_API_URL` | no | `http://api:4000` | API the MCP server proxies to (service-internal; named distinctly so a caller-facing `TALLYLINE_API_URL` can't misroute it) |
| `TALLYLINE_TOKEN` / `TALLYLINE_WORKSPACE` | no | — | Set both → single-tenant mode; neither → per-request header passthrough (see [klavis.md](./klavis.md)) |
| `TALLYLINE_ALLOW_API_URL_OVERRIDE` | no | off | `1` honors `x-tallyline-api-url` per request — needed for a multi-deployment hosted endpoint; SSRF surface, enable deliberately |

## Cloudflare Tunnel — public access, zero open ports

The free path to put a homelab instance on a real hostname without
exposing anything inbound:

```bash
# on the host running the stack
cloudflared tunnel login
cloudflared tunnel create tallyline
cloudflared tunnel route dns tallyline tallyline.example.com
```

`~/.cloudflared/<tunnel-id>.json` + this `config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  # web on the apex, api on /api/* OR a subdomain — pick one pattern
  - hostname: tallyline.example.com
    service: http://localhost:3100
  - hostname: api.tallyline.example.com
    service: http://localhost:4000
  - service: http_status:404
```

```bash
cloudflared tunnel run tallyline
# or install as a service: cloudflared service install
```

Then set `API_BASE_URL=https://api.tallyline.example.com` +
`NEXT_PUBLIC_API_URL=https://api.tallyline.example.com` (rebuild the web
image — the var is build-time), restart. Webhooks (GitHub/Slack) then
reach the API through the tunnel; their signature checks are unchanged.
Cookie `Secure` engages automatically via `NODE_ENV=production` + HTTPS.

## Railway — managed path

A Railway project maps cleanly onto three services:

1. **Postgres** — Railway's postgres plugin.
2. **API** — deploy from repo, root `apps/api/Dockerfile`; env
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
   `JWT_SECRET`, `API_BASE_URL` =
   the service's public domain. Migrations run on boot — no release step needed.
3. **Web** — deploy `apps/web/Dockerfile` with build arg
   `NEXT_PUBLIC_API_URL` = the API domain and env
   `API_INTERNAL_URL` = the API's *internal* Railway domain
   (`http://api.railway.internal:4000`).

A `railway.json`/template button lands when the Dockerfile paths stabilize;
until then the three-service manual setup is the documented route (~10 min).

## Upgrading

```bash
git pull
docker compose -f docker-compose.selfhost.yml up -d --build
```

Migrations apply automatically on API boot (forward-only — read the release
notes before jumping versions). No manual migration step exists today.

### Upgrading to the OAuth/org-identity release (migrations `0018`–`0019`)

`0019` is the **point of no return** — it dedupes workspace-scoped users
into global identities and drops `users.workspace_id`. Rows it merges are
snapshotted in `user_id_map` and every FK'd + actor column is re-pointed
before the losers delete, but that is data surgery, not a rollback path.

1. **Dump first.** `pg_dump` per [Backup](#backup--restore) — restoring
   that dump is the only rollback for this release.
2. **Single-instance window.** Stop every running API/web replica before
   upgrading: old code selects `users.workspace_id` against a dropped
   column, so a mixed fleet isn't degraded — it's dead. Migrations run
   under a `pg_advisory_lock` on API boot, so the first replica up
   migrates and the rest wait.
3. **Journal-drift reconcile** — only for installs that ever applied a
   retagged/edited migration: if boot fails with a migration-hash or
   "already applied" error, compare `drizzle.__drizzle_migrations.hash`
   against the shipped files under `apps/api/drizzle/`; a row whose hash
   doesn't match its file was applied from a different build — fix by
   restoring the dump and re-upgrading from a clean tree.
4. **Post-check.** Sign in once per auth method, and if you carried
   `.env` over: `AUTH_SECRET` is gone (dead var, nothing read it);
   `AUTH_SECRET_KEY` is the new provider-secret key.

## Backup & restore

Everything durable lives in the `tallyline-postgres` volume.

```bash
# backup — consistent dump while the stack runs
docker compose -f docker-compose.selfhost.yml exec postgres \
  pg_dump -U postgres -Fc tallyline > backup-$(date +%F).dump

# restore — stop api/web, recreate the db, replay
# (two separate -c calls: DROP DATABASE refuses to run inside the
# implicit transaction a multi-statement -c creates)
docker compose -f docker-compose.selfhost.yml stop api web
docker compose -f docker-compose.selfhost.yml exec postgres \
  psql -U postgres -c "DROP DATABASE tallyline;"
docker compose -f docker-compose.selfhost.yml exec postgres \
  psql -U postgres -c "CREATE DATABASE tallyline;"
cat backup-YYYY-MM-DD.dump | docker compose -f docker-compose.selfhost.yml \
  exec -T postgres pg_restore -U postgres -d tallyline --clean --if-exists
docker compose -f docker-compose.selfhost.yml start api web
```

### Automated encrypted offsite backup (`ops/`)

`ops/backup.sh` runs `pg_dump -Fc` → gzip → [age](https://age-encryption.org)
(public-key, so the private key never sits on the box) → an S3-compatible
bucket (Cloudflare R2) via the AWS CLI, plus a `.sha256`. `ops/restore.sh`
reverses it. Both are plain bash; deps: `age`, `gzip`, `aws` (v2), and
`docker` or the Postgres client tools.

One-time setup:

```bash
age-keygen -o tallyline-backup.key      # prints the PUBLIC key (age1...)
# store tallyline-backup.key in your password manager / second machine; NOT on the server
```

Create an R2 bucket (enable object versioning or Object Lock, because a write-only token
cannot delete but can still overwrite a dump) with a **scoped API token** (object write on that bucket only —
no delete or list, so a compromised host cannot erase the off-host copies) and a
lifecycle rule that keeps the newest 14 daily files (and, if you want, 8 weekly
copies under a separate prefix). Retention lives in the bucket, not in the timer.

#### Scheduled backups (systemd timer)

`ops/systemd/` ships a oneshot service and a nightly timer (03:17 host-local time,
`Persistent=true` so a missed night runs at next boot). On the host:

```bash
# 1. secrets file, root-owned, chmod 600 (see below). Plain KEY=value lines; systemd does
#    not understand `export` or shell expansion.
sudo install -m 0600 -o root -g root /dev/null /srv/tallyline/.backup.env
sudoedit /srv/tallyline/.backup.env
# 2. install and start the timer (edit WorkingDirectory/paths in the unit if the checkout is not /srv/tallyline)
sudo cp ops/systemd/tallyline-backup.service ops/systemd/tallyline-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tallyline-backup.timer
# 3. prove it: run once now, check the log and the healthcheck, then confirm the timer is scheduled
sudo systemctl start tallyline-backup.service && journalctl -u tallyline-backup.service -n 20 --no-pager
systemctl list-timers tallyline-backup.timer
```

The service keeps an encrypted local copy in `/var/backups/tallyline` (the last
14 days; `BACKUP_OUT_DIR` in `.backup.env` overrides it) as well as the off-host
upload. `BACKUP_AGE_RECIPIENT` must be the **public** key; `backup.sh` refuses an
`AGE-SECRET-KEY-` value. Keep the private key on your laptop plus one offline copy.

Prefer cron? The same script works from a crontab line:

```cron
17 3 * * * cd /srv/tallyline && set -a && . ./.backup.env && set +a && ./ops/backup.sh >> /var/log/tallyline-backup.log 2>&1
```

`.backup.env` (chmod 600) holds `BACKUP_AGE_RECIPIENT`, `BACKUP_PG_CONTAINER`
(+ `BACKUP_PG_USER`/`BACKUP_PG_DB`), `BACKUP_S3_BUCKET`,
`BACKUP_S3_ENDPOINT` (`https://<accountid>.r2.cloudflarestorage.com`),
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally
`BACKUP_HEALTHCHECK_URL` (healthchecks.io: pinged on success, `/fail` on error).
`BACKUP_SKIP_UPLOAD=1` + `BACKUP_OUT_DIR=…` keeps the encrypted file locally.

**Restore procedure** (tested end to end against throwaway Postgres containers —
dump of a migrated database, encrypted, restored into a fresh database;
table count and row counts matched; wrong key, tampered file and missing
target all fail closed):

```bash
# 1. stop writers on a live box
docker compose -f docker-compose.selfhost.yml stop api web
# 2. create an empty target database (never restore over a database you can't lose)
docker compose -f docker-compose.selfhost.yml exec postgres psql -U postgres -c "CREATE DATABASE tallyline_restore;"
# 3. fetch + verify checksum + decrypt + restore (target is explicit: no default)
BACKUP_AGE_IDENTITY=./tallyline-backup.key \
RESTORE_PG_CONTAINER=<postgres-container> RESTORE_PG_DB=tallyline_restore \
BACKUP_S3_BUCKET=... BACKUP_S3_ENDPOINT=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
./ops/restore.sh tallyline-YYYYMMDDTHHMMSSZ.dump.gz.age     # or a local file path
# 4. sanity-check row counts, then point DATABASE_URL/POSTGRES_DB at it and start api/web
```

**Rehearse it** — restore the latest backup into a scratch database at
least monthly; an untested backup is not a backup. The database name in the
compose file is `tallyline` (kept so existing volumes work); the older manual
snippet above says `tallyline` — use whatever `POSTGRES_DB` is on your box.

## Hardening checklist

- `JWT_SECRET` is set and not the dev default (enforced: the API won't boot in production otherwise).
- Postgres is **not** published (the compose file never maps it).
- `RATE_LIMIT_PER_MIN` > 0 on anything internet-facing.
- `AUTH_AUTO_JOIN_SINGLE_WORKSPACE` left unset (off) on anything internet-facing —
  turning it on means any OAuth-verified stranger lands in your workspace.
- `TALLYLINE_ALLOW_WORKSPACE_CREATE` left unset unless you want every member to create orgs.
- `TALLYLINE_WEBHOOK_ALLOW_PRIVATE` left unset on shared hosts (SSRF guard).
- `TRUSTED_PROXY=1` **when** a real proxy/Cloudflare fronts the API (required for per-client rate limits and HSTS) — unset otherwise.
- Security headers (CSP, HSTS on https, nosniff, frame-ancestors none) are set by the app; add a Cloudflare rate-limit rule on `/v1/auth/*` and Turnstile on login as a second layer.
- Behind TLS before inviting anyone — cookies go `Secure` automatically.
- Proxy/ingress access logs redact `GET /v1/auth/oauth/*` query params —
  `invite`, `return_to`, `login_nonce`, and `code` are bearer
  credentials riding a URL (the API emits no per-request log itself;
  check nginx/traefik/Cloudflare log config).
- Webhook secrets set per provider (GitHub/Slack verify HMACs — see
  [security-review.md](./security-review.md)); OAuth provider setup in
  [auth.md](./auth.md).
