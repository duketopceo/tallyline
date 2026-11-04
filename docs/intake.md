# Intake: first-party reports, Sentry and GlitchTip

Tallyline has one intake spine. Every source below is normalised into the same
`IntakeInput` (`apps/api/src/services/intake-normalize.ts`) and then goes
through `ingestIntake`, so dedupe, occurrence counts, triage state and the
"reported via" provenance line behave identically whichever door the report
came through.

```
app / Sentry / GlitchTip  ->  normaliser  ->  ingestIntake  ->  triage issue on a team
```

## First-party reports (a per-project intake key)

`POST /v1/intake/:key`, no session. Mint a key in Settings → Intake. Body:

| Field | Required | Notes |
|---|---|---|
| `kind` | yes | `error`, `bug`, `help` or `issue` |
| `title` | yes | capped at 500 characters |
| `body` | no | plain text, line breaks kept, capped at 100 KB |
| `provider` | no | defaults to `intake`; a label for your app |
| `fingerprint` | no | your error identity; repeats fold onto one issue. Scoped to the key |
| `externalId` | no | your delivery id; a replay is dropped. Scoped to the key |
| `url` | no | must be `https://` |
| `severity` | no | `fatal`, `error`, `warning`, `info` |
| `occurredAt` | no | ISO string or epoch; stored as ISO |
| `payload` | no | JSON object kept on the intake event (capped at 16 KB) |
| `reporter` | no | `{ email?, name?, followUp? }` — asks for a follow-up handle |

```bash
curl -sS -X POST "$API/v1/intake/$TALLY_INTAKE_KEY" \
  -H 'content-type: application/json' \
  -d '{"kind":"bug","title":"Checkout hangs","body":"Steps:\n1. open cart","fingerprint":"checkout-hang"}'
# -> {"issueKey":"ENG-42","reporterToken":null,"deduped":false}
```

## Sentry

Sentry signs every webhook delivery with the integration's **Client Secret**.
Tallyline verifies the signature (`sentry-hook-signature`, hex HMAC-SHA256 of
the raw body) **before** the payload is parsed; an unsigned or badly signed
delivery is `401 INVALID_SIGNATURE` and writes nothing.

1. On the server, set `SENTRY_SIGNING_SECRET` to the Sentry Client Secret.
   Without it, every Sentry delivery is refused with
   `503 SENTRY_NOT_CONFIGURED` (GlitchTip does not need it).
2. Create (or copy) the error-source webhook URL in Settings → Integrations →
   GlitchTip. The same URL serves both senders; its last path segment is the
   workspace secret:
   `https://your-api.example/webhooks/glitchtip/<tly_gt_…>`
3. In Sentry: Settings → Integrations → Webhooks (or an internal integration)
   with that URL, and copy its Client Secret into `SENTRY_SIGNING_SECRET`.
4. Map the Sentry project name to a Tallyline team in the same settings panel
   (case-insensitive), or set a default team.

Supported payloads: issue alerts (`action: "triggered"`) and new-issue
notifications (`action: "created"`), in the `data.event` envelope or a bare
event. `resolved`, `assigned` and `ignored` notifications are acknowledgements
and map to nothing, so they answer `200` with `ignored: true`.

### Field mapping

| Sentry field | Tallyline |
|---|---|
| `data.event.title`, then `message`, then `issue.title` | issue title (capped at 500) |
| `data.event.issue_id` (or `data.issue.id`) plus the project name | dedupe fingerprint `sentry:<project>/<issue_id>` |
| `data.event.event_id` | delivery id — a replay of the same event is dropped |
| `data.event.web_url` / `permalink` (https only) | issue link |
| `data.event.level` | severity (`fatal`/`warning`/`info` pass through, `debug` becomes `info`, anything else `error`) |
| `data.event.culprit` | `Culprit:` body line |
| `data.event.project_name` (or `project.name`/`project`) | picks the team, and a `Project:` body line |
| `data.event.platform`, `release.version`, `tags[]` | `Platform:`, `Release:` and one body line per tag (max 20 tags) |
| `data.event.datetime` / `timestamp` | `occurredAt` |

## GlitchTip

GlitchTip cannot sign requests or add headers, so the URL secret is the
credential and there is no signature step. Everything else is the same path:
one issue attachment becomes one intake event, on the team mapped to the
GlitchTip project name. The full setup, payload mapping, dedupe rules and
limits live in [glitchtip.md](./glitchtip.md).

The mapping below is the same table as above, read from GlitchTip's alert
body; both documents describe one normaliser.

| GlitchTip field | Tallyline |
|---|---|
| `attachments[].title` | issue title (capped at 300) |
| `attachments[].title_link` issue URL | dedupe fingerprint `glitchtip:<host>/<org>/<id>` and the issue link |
| `attachments[].text` | `Culprit:` body line |
| `fields[]` Project | picks the team |
| `fields[]` other values | body lines |
| `attachments[].color` | severity (`#e52b50` error, `#e9b949` warning, `#4b60b4` info) |

## Test a signed delivery with curl

```bash
SECRET="the Sentry client secret"
BODY='{"action":"triggered","data":{"event":{"event_id":"abc123","title":"Test error","level":"error","issue_id":"1","project_name":"portal-ui","web_url":"https://sentry.example/organizations/acme/issues/1/"}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -sS -X POST "$API/webhooks/glitchtip/$TALLY_GLITCHTIP_SECRET" \
  -H 'content-type: application/json' \
  -H "sentry-hook-signature: $SIG" \
  -d "$BODY"
```

Drop the signature header and the same request answers `401 INVALID_SIGNATURE`.
A GlitchTip delivery is tested the same way without the header (see
[glitchtip.md](./glitchtip.md)).
