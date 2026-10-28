# Authentication & SSO

tallyline supports email/password (built-in), GitHub, Google, and any
generic OIDC provider. Humans are global identities — one `users` row
with memberships into workspaces — so a single sign-in can roam every
workspace the account belongs to, and `/workspaces` offers a chooser
when it belongs to more than one.

This page is the operator doc: provider setup, callback URLs, the
linking/JIT rules, env-vs-DB precedence, and troubleshooting.

## Callback URLs

Every provider redirect lands on the API, not the web app:

```
{API_BASE_URL}/v1/auth/oauth/github/callback
{API_BASE_URL}/v1/auth/oauth/google/callback
{API_BASE_URL}/v1/auth/oauth/oidc/callback
```

`API_BASE_URL` is the public API origin (the same var used for webhook
callbacks). The API bounces the browser to `WEB_URL` after the code
exchange — set both correctly or the flow dead-ends at the last hop.

## Provider setup

### GitHub

GitHub Apps already carry OAuth credentials — the same `GITHUB_CLIENT_ID`
used for issue sync doubles as the sign-in provider when
`GITHUB_CLIENT_SECRET` is set. To use a separate OAuth App instead:
GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.

- **Authorization callback URL:** `{API_BASE_URL}/v1/auth/oauth/github/callback`
- **Scopes (automatic):** `read:user user:email` — needed to resolve the
  primary verified email.

### Google

Google Cloud Console → APIs & Services → Credentials → Create OAuth
client ID → Web application.

- **Authorized redirect URI:** `{API_BASE_URL}/v1/auth/oauth/google/callback`
- **Scopes (automatic):** `openid email profile`.
- The consent screen needs `email`/`profile` — internal workspaces can
  restrict to the Google Workspace org.

### Generic OIDC

Any spec-compliant IdP (Keycloak, Authentik, Entra, Okta, Dex…).
Configure `OIDC_ISSUER` to the issuer base — discovery runs against
`{OIDC_ISSUER}/.well-known/openid-configuration`, so **no endpoint URLs
are configured or trusted by hand**.

- **Redirect URI at the IdP:** `{API_BASE_URL}/v1/auth/oauth/oidc/callback`
- `OIDC_SCOPES` defaults to `email profile` (`openid` is always added).
- `OIDC_DISPLAY_NAME` sets the button label on the login page.

All provider endpoints are validated server-side: https-only, public
DNS, private/link-local/metadata IPs blocked. An IdP on a private
address is rejected — run the API with a routable IdP.

## Providers: env vs. DB

Two places to define providers, env wins:

| Source | Managed in | Notes |
|---|---|---|
| Env vars (`GITHUB_*`, `GOOGLE_*`, `OIDC_*`) | `.env` / compose | Shadow any DB row with the same key; can't be edited or deleted in the UI |
| DB rows | `/settings/providers` | Created/edited by instance admins; secrets AES-256-GCM-encrypted at rest, shown masked |

Instance admins = `AUTH_ADMIN_EMAILS`. **When that var is unset, the
bootstrap workspace owner is the fallback instance admin** — a fresh
install can reach the providers UI without any env config.

`POST /v1/auth/providers/:id/test` probes discovery/client-metadata from
the API server — use it after saving, before pointing users at the
button.

## Sign-in → identity resolution

After a provider callback verifies state, PKCE, and nonce, claims are
resolved in order:

1. **`auth_identities` hit** — returning user; session minted.
2. **Invite token carried through the flow** — consumed here for
   existing users; new users continue to rung 4.
3. **Verified-email match to an existing account** — governed by
   `AUTH_ACCOUNT_LINKING`:
   - `auto` (default): identity linked, signed in.
   - `login`: a pending-link code is issued; the web `/link` page proves
     control of the existing account (password or already-authenticated
     session) before the identity attaches. The link step never mints a
     session itself.
   - `disabled`: the match is treated as a new user.
4. **JIT create** — new global user, then:
   - email-bound invite: `user.email` must equal `invites.email`;
   - open invite: token-only, consumed atomically;
   - single workspace + `AUTH_AUTO_JOIN_SINGLE_WORKSPACE=1` (off by default): auto-join;
   - multiple/zero workspaces: pending-bootstrap — a 10-minute code
     carries the user to `/bootstrap` to create or join a workspace.
5. No workspace created → a `pending-bootstrap` code carries the new
   user to `/bootstrap`.

`AUTH_ALLOWED_EMAIL_DOMAINS` filters JIT account creation by email
domain (invite claims bypass it — the invite is itself authorization).
IdPs that omit an `email_verified` claim are treated as unverified:
their users can only enter via invite, and email-match linking requires
the `login` proof regardless of the `auto` setting.

## Invites

`POST /v1/workspaces/:ws/invites` (owner/admin) creates a hashed-at-rest,
single-use token, default 7-day expiry. Options: `email` binding,
`teamId` pre-assignment, `role` (`member`/`admin` — never `owner`).

- **Existing user:** accept at `/join/{token}` while signed in, or
  `POST /v1/auth/accept-invite` with a session.
- **New user:** the same link carries them through password setup or an
  OAuth round-trip; the token rides the OAuth state cookie (hashed), not
  the authorize URL.
- Password-only installs: the accept endpoint also takes
  `{name, password}` and creates the account — the invite is the only
  account-creation surface when every provider is off.

## Sessions, workspaces, and the chooser

- `tly_session` — HttpOnly cookie session, `Secure` in production,
  sha256-hashed at rest.
- `tly_ws` — active-workspace cookie the web bridges read; the chooser
  at `/workspaces` sets it (and re-binds the session server-side).
- Cookie sessions roam all member workspaces per request — membership
  is checked on every call, so removal is effective immediately.
- PATs (`tly_pat_*`), access JWTs, and agent keys (`tly_agt_*`) are
  workspace-bound. None can create workspaces, manage members/invites/
  providers, or mint credentials — those are cookie+role-gated.

## Device sign-in for the CLI (RFC 8628)

OAuth access tokens (`tly_oat_`) are audience-bound to `/mcp` and are refused on
`/v1`, so a CLI cannot sign in through the OAuth server. Headless clients use the
device authorization grant instead and end up holding a personal access token.

1. `POST /v1/auth/device/code` `{ "clientName": "Tallyline CLI on kate-mbp" }` returns
   `device_code` (secret, kept by the client), `user_code` (`BCDF-GHJK`, shown to
   the human), `verification_uri`, `verification_uri_complete`, `expires_in`
   (600 s) and `interval` (5 s). Unauthenticated, behind the auth limiter, and at
   most 20 live codes per client address.
2. The human signs in on the web and approves the code for a workspace:
   `GET /v1/workspaces/{ws}/device/{userCode}` shows what is asking (client name,
   requesting address, expiry); `POST` the same path with
   `{ "decision": "approve" | "deny", "scopes": ["read","write"] }` decides. Same
   bar as minting a token in Settings: cookie session, verified email, admin role.
   Delegated tokens and agent keys cannot approve. Wrong, expired, used and
   short codes all return the same 404.
3. `POST /v1/auth/device/token` `{ "deviceCode": "..." }` is polled by the client.
   `400` carries `authorization_pending`, `slow_down` (the interval grows by 5 s),
   `access_denied` or `expired_token`. The first poll after approval returns
   `200 { access_token, token_type: "Bearer", scope }`: a `tly_pat_` token that
   expires in 90 days and is named after the client. The token is minted at that
   moment, once; replaying the device code returns `expired_token`. Nothing in
   `device_authorizations` is a credential (the device code is stored as a hash).

Approvals are written to the workspace feed as `device_authorized` and
`device_denied`. The web page at `/device` that renders step 2 is not built yet,
so `verification_uri` currently points at a route the web app does not serve.

## Operational flags

| Var | Effect |
|---|---|
| `AUTH_DISABLE_PASSWORD=1` | Hides password login + disables the login route. SSO-only installs. Don't set before at least one provider works |
| `AUTH_ACCOUNT_LINKING` | `auto`/`login`/`disabled` — see resolution rung 3 |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | JIT domain allowlist; invites bypass |
| `AUTH_AUTO_JOIN_SINGLE_WORKSPACE` | **Default off** (changed from on). `1`: a new OAuth user lands in the workspace when the instance has exactly one. On internet-facing installs this is open membership |
| `TALLYLINE_ALLOW_WORKSPACE_CREATE` | Default off: `POST /v1/workspaces` needs an instance admin. `1` lets any signed-in human create workspaces |
| `TRUSTED_PROXY=1` | Trust `CF-Connecting-IP` / last `X-Forwarded-For` hop (rate limits) and `X-Forwarded-Proto` (HSTS, `Secure`). Set only behind Cloudflare or a real proxy — spoofable otherwise |
| `AUTH_SECRET_KEY` | AES-256-GCM key (`openssl rand -base64 32`) encrypting DB provider secrets. **Rotating or losing it renders stored secrets undecryptable** — re-enter them in `/settings/providers` (no key-versioned envelope in v1) |
| `AUTH_ADMIN_EMAILS` | Instance-admin emails; unset → bootstrap owner fallback |
| `AUTH_DISABLE_PASSWORD` note | Password mint routes (`login`, bootstrap) return `PASSWORD_DISABLED`; agent/PAT/JWT auth unaffected |

## OAuth hardening inventory

- `state` (32B), `nonce`, PKCE S256 in HttpOnly `SameSite=Lax` cookies,
  10-minute TTL, `Secure` in production.
- One-time exchange codes: 60s TTL for `login`, 10min for
  `pending-bootstrap`/`pending-link` (a human has to fill a form);
  claimed atomically — discovery reads never consume them.
- `tly_login_nonce` binds the browser that clicked the provider button
  to the session minted from the exchanged code (login-CSRF fix).
- `return_to` is same-origin-relative only; anything else falls back
  to `/`.
- `invite` rides the state cookie — never the authorize URL — and is
  hashed at rest once consumed.
- The API emits no per-request access log; any proxy/ingress log must
  redact `start`/callback query params (`invite`, `return_to`,
  `login_nonce`, `code`) — bearer credentials ride GETs.

## Troubleshooting

| Symptom | Cause |
|---|---|
| OIDC discovery 404s | `OIDC_ISSUER` trailing slash mismatch — use the issuer exactly as the IdP publishes it |
| Login loop back to `/login` | `SameSite` cookie blocked — callback must be same-site (or your IdP must sit under the same eTLD+1); also check `WEB_URL` matches what the browser actually visits |
| `state mismatch` | Clock skew beyond the 10-min cookie TTL, or cookies dropped by a proxy — set `TRUSTED_PROXY=1` and check `Secure` handling behind TLS-terminating proxies |
| Provider button missing | Client id empty (env) or row disabled (DB); env rows shadow DB rows of the same key |
| `BAD_ENDPOINT` on save/test | Endpoint failed the https+public-IP check — private IdPs are rejected |
| Invite "already used" | Single-use claim raced or the link was forwarded after acceptance — mint a fresh invite |

## Pairing a phone

The Tallyline iOS app signs in by scanning a QR code, so nobody types a server
address or a token.

1. In the web app (Settings, Devices) a signed-in person with a verified email
   asks for a pairing code: `POST /v1/workspaces/:ws/devices/pairing`. The answer
   holds a single-use code that is good for **five minutes** and a
   `tallyline://pair?server=…&code=…` URL to render as a QR code. Any workspace
   member can do this for their own phone (unlike creating a personal access
   token, which stays admin-only). At most five unused codes at a time, ten
   per ten minutes.
2. The phone scans it and calls `POST /v1/auth/pair/redeem` with the code, a
   device name and a platform. This is unauthenticated and rate limited. A wrong,
   expired, already-used or orphaned code (its minter left the workspace) all
   answer the same `400 INVALID_PAIRING_CODE`.
3. The answer carries a **device credential**: an ordinary `tly_pat_` token with
   read and write scope that expires in **90 days**, plus the server address and
   workspace. It acts as that person with that person's role, and nothing more:
   it can't mint tokens, pairing codes or agent keys.

A paired phone can swap its credential for a fresh one before it lapses
(`POST /v1/workspaces/:ws/devices/current/rotate`). The old credential keeps
working for ten more minutes so a response lost on a bad network can't lock the
phone out; only the newest credential can rotate. A phone can sign itself out
(`DELETE .../devices/current`).

People list their devices (`GET .../devices`) and revoke any of them
(`DELETE .../devices/:id`); revoking deletes the credential (and a grace
credential from a recent rotation), so the phone gets `401` on its very next call.
Only the hash of a pairing code or credential is ever stored, and every pairing,
rotation and revocation is written to the audit trail.

