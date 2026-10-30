# Push notifications

Tallyline can wake the iOS app when something needs you. Push is off unless
you configure it. A server without a relay URL sends nothing and phones show
"push off".

## What a push contains

Nothing about your work. The phone gets one of four fixed lines and a badge
count:

| Kind | Text on the lock screen |
|---|---|
| `assigned` | Something was assigned to you |
| `mention` | You were mentioned |
| `review_pending` | A review is waiting for you |
| `dispatch_failed` | An agent run needs attention |

No issue titles, keys, workspace names or comments leave your server. The app
fetches the detail from your own server after it wakes up.

## How it fits together

```
your Tallyline server ──signed ping──▶ push relay ──▶ Apple (APNs) ──▶ phone
```

Apple only accepts pushes signed with the App Store key, so a self-hosted
server can't talk to Apple directly. The relay (`apps/push-relay`) holds that
key and forwards pings. It never sees content and keeps no database.

1. The app reads `GET /v1/workspaces/:ws/push/config` from your server. It
   returns `{ enabled, relayUrl, serverKey }`. `serverKey` is your server's
   Ed25519 public key.
2. The app sends its Apple device token and `serverKey` to the relay at
   `POST /v1/handles`. The relay returns a sealed handle (AES-256-GCM, prefix
   `h1.`). Only the relay can open it, and it only works for that server key.
3. The app gives the handle to your server:
   `PUT /v1/workspaces/:ws/devices/current/push { handle, environment }`.
   Only a paired device credential can call this. `DELETE` turns push off for
   that phone.
4. When a notification is created, the server signs
   `{ v, handle, kind, badge, ts, nonce }` and posts it to the relay's
   `POST /v1/push`. Headers: `x-tallyline-server-key` and
   `x-tallyline-signature` (Ed25519 over the raw body).
5. The relay checks the signature, the clock (5 minutes either way) and the
   nonce (no replays), opens the handle, and sends a fixed alert to Apple.

Your server never holds the Apple device token. The relay never holds your
data. Neither can push to a phone without the other.

### Relay answers

| Status | Meaning | Server does |
|---|---|---|
| 202 | Sent | Counts it |
| 401 | Bad signature or stale clock | Logs a warning |
| 409 | Replayed nonce | Logs a warning |
| 410 | Handle unknown, from another server, or Apple says the phone is gone | Forgets the handle |
| 429 | Rate limit (30 per handle, 600 per server, 30 handle sign-ups per IP, per minute) | Logs a warning |
| 502 | Apple unreachable | Logs a warning |

A slow or dead relay never blocks a write. Pings run in the background with a
5 second timeout.

## Per-person settings

`GET` and `PUT /v1/workspaces/:ws/push/preferences` (signed-in people only,
not agents):

```json
{ "disabledKinds": ["assigned"], "quietStart": 1320, "quietEnd": 420, "tz": "America/Denver" }
```

`quietStart` and `quietEnd` are minutes after midnight in `tz`. Quiet hours
may wrap midnight. Set all three or none. Revoking a device also clears its
handle.

## Server setup

| Variable | Meaning |
|---|---|
| `TALLYLINE_PUSH_RELAY_URL` | Relay base URL. Must be `https://`, except `http://localhost` or `127.0.0.1` for testing. Unset means push is off. |

The signing key is derived from `AUTH_SECRET_KEY` (or `JWT_SECRET` when that
is unset). Rotating it changes the server key. Phones then get 410 from the
relay and must register push again, which the app does on its next launch.

## Running a relay

Most people use the project's relay. Running your own only makes sense if you
ship your own build of the iOS app with your own App ID.

```sh
pnpm --filter @tallyline/push-relay build
PUSH_RELAY_HANDLE_KEY=$(openssl rand -base64 32) \
APNS_TEAM_ID=... APNS_KEY_ID=... APNS_PRIVATE_KEY_FILE=/run/secrets/apns.p8 \
APNS_TOPIC=your.bundle.id \
node apps/push-relay/dist/main.js
```

| Variable | Meaning |
|---|---|
| `PUSH_RELAY_HANDLE_KEY` | 32 random bytes, base64. Seals handles. Changing it makes every phone register again. |
| `APNS_TEAM_ID`, `APNS_KEY_ID` | From the Apple developer account |
| `APNS_PRIVATE_KEY` or `APNS_PRIVATE_KEY_FILE` | The `.p8` key, inline or as a file path. Prefer the file. |
| `APNS_TOPIC` | The app's bundle ID |
| `PORT` | Default `8790` |
| `PUSH_RELAY_TRUST_PROXY` | `1` to read the client IP from `X-Forwarded-For` behind a proxy |

The relay refuses to start unless every required variable is set. It logs one
JSON line per event and never logs tokens, handles or payloads. Put it behind
TLS. `GET /health` returns 200.

## Design note

The plan had the server receive the Apple token at pairing time. The shipped
design has the phone register with the relay instead, so the server only ever
stores a sealed handle. That keeps device tokens off self-hosted servers and
lets a phone change its token without a new pairing.
