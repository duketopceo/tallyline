# GlitchTip integration

GlitchTip alerts land in Tallyline as triage issues, on the team that owns the
GlitchTip project. No translator sits in between: GlitchTip posts its own alert
payload to a Tallyline URL, and the receiver feeds the same intake pipe as
`POST /v1/workspaces/:ws/intake` (dedupe, occurrence counts, triage, never
auto-accepted). See [github-sync.md](./github-sync.md) and [slack.md](./slack.md)
for the other inbound integrations.

## How it works

```
GlitchTip alert  ->  POST /webhooks/glitchtip/<secret>  ->  intake  ->  triage issue on the mapped team
```

- One integration per workspace. Its secret is the last path segment of the
  webhook URL. Tallyline stores only the sha256 of it plus its last four
  characters, and shows the full URL once, when you create or rotate.
- GlitchTip cannot sign requests or add headers, which is why the secret lives
  in the URL.
- Each issue attachment in a delivery becomes one intake event with provider
  `glitchtip`. A batched alert (several issues in one post) lands every issue,
  up to 25 per delivery: attachments beyond the 25th are not ingested and are
  counted in the response's `dropped` field (GlitchTip itself caps issues per
  alert, so this only matters for hand-made posts).

### Payload mapping

| GlitchTip field | Tallyline |
|---|---|
| `attachments[].title` | issue title (capped at 300 characters) |
| `attachments[].title_link` (`<GlitchTip URL>/<org>/issues/<id>`) | issue link and the dedupe fingerprint `glitchtip:<host>/<org>/<id>` |
| `attachments[].text` (culprit) | `Culprit:` line in the body |
| `fields[]` Project | picks the team (see below) |
| `fields[]` Environment, Server Name, Release, extra tags | lines in the body |
| `attachments[].color` | severity: `#e52b50` error, `#e9b949` warning, `#4b60b4` info |

Severity limits: GlitchTip colors error and fatal the same, so `fatal` never
appears. Any other color maps to `error`.

### Dedupe

- The fingerprint is the GlitchTip issue, so the first alert creates an issue
  and every later alert for the same GlitchTip issue raises its occurrence
  count and leaves a comment instead of creating a duplicate. A declined or
  canceled Tallyline issue keeps absorbing repeats; a done one is reopened as a
  new issue.
- GlitchTip sends no delivery id and does not retry. Tallyline uses a hash of
  the body plus the current minute as the delivery id, so an identical post in
  the same minute is dropped as a duplicate delivery and the same alert a
  later minute counts as a new occurrence.

### Teams and unmapped projects

The integration holds a map from GlitchTip project name (case-insensitive) to
a team key, and optionally a default team.

- Mapped project: lands on that team.
- Unmapped project with a default team: lands on the default team.
- Unmapped project and no default team: the whole delivery is rejected with
  `422 UNMAPPED_PROJECT` and nothing is created. GlitchTip does not retry, so
  watch for `last alert` not advancing in Settings.

Created issues are in `triage`, `source: intake`, created by the `system`
actor. This integration never sends error text to the LLM triage ranker, even
when ranking is enabled for manual intake: error messages come from end users
and are untrusted input.

### Limits and responses

| Case | Response |
|---|---|
| Unknown, rotated, disabled or deleted secret | `404 NOT_FOUND`, nothing written |
| Body is not JSON | `400 MALFORMED_PAYLOAD` |
| Body over 256 KB | `413 PAYLOAD_TOO_LARGE` |
| No issue attachments (uptime alerts, test pings) | `200` with `ignored: true` |
| Unmapped project, no default team | `422 UNMAPPED_PROJECT` |
| Mapped team does not exist | `422 UNKNOWN_TEAM` |
| More than 25 attachments | first 25 are ingested, the rest counted in `dropped` |
| Issue link on another host than the first accepted alert | dropped and counted in `dropped` |

Only the generic **Webhook** and **Slack** recipient types send the supported
shape. Discord, Google Chat, ntfy, Teams, Zulip and Feishu recipients send
other shapes and are not supported.

## Set up from the web

1. Settings > Integrations > GlitchTip. Add one row per GlitchTip project (the
   project name as GlitchTip shows it) and pick its team. Optionally pick a
   default team.
2. **Set up GlitchTip**. The webhook URL appears once. Copy it.
3. In GlitchTip, open each project > Alerts > add a recipient of type Webhook
   (or Slack) with that URL. For one alert per new error use a threshold of 1
   event in 1 minute.

**Rotate secret** issues a new URL and kills the old one immediately; update
the GlitchTip recipients afterwards. **Delete** removes the integration.

## API

Owner or admin only. Agent keys are refused.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/workspaces/:ws/glitchtip` | status: `integration` or `null`; never the secret |
| `PUT` | `/v1/workspaces/:ws/glitchtip` | create (returns `token` and `webhookUrl` once, `201`) or update `projectMap`, `defaultTeamKey`, `enabled` |
| `POST` | `/v1/workspaces/:ws/glitchtip/rotate` | new secret, returned once |
| `DELETE` | `/v1/workspaces/:ws/glitchtip` | remove |

`webhookUrl` is built from `API_BASE_URL`. Check it is your public API URL
before pasting it anywhere.

## Operator script: onboard Pace and Wisp

`ops/glitchtip-onboard.py` does the whole setup against a running instance:
creates the `PACE` and `WISP` teams, creates the integration with a project
map, and adds one alert named `tallyline` on every mapped GlitchTip project
that posts to the webhook URL.

```bash
python3 ops/glitchtip-onboard.py              # dry run: reads only, prints the plan
python3 ops/glitchtip-onboard.py --apply      # make the changes
python3 ops/glitchtip-onboard.py --apply --rotate   # mint a new secret and repoint every alert
python3 ops/glitchtip-onboard.py --self-test  # offline checks, no network
```

- Credentials come from omaseal and are never printed: the Tallyline token from
  `tallyline personal` (an owner or admin token), the GlitchTip token from
  `glitchtip api` or else `glitchtip Personal`. Override with `--tally-secret`
  and `--glitchtip-secret` (`SERVICE/ACCOUNT`).
- Tallyline shows the webhook URL only once, so the script stores it in omaseal
  as `tallyline glitchtip-webhook`. If the integration exists but that secret is
  missing, the script stops and asks for `--rotate`.
- Projects are mapped by whole words in their name or slug: `wisp` goes to
  `WISP`; `pace`, `portal`, `ui`, `strut`, `relay`, `sidecar`, `tenant`,
  `stackd` go to `PACE`; `kate` goes to `KATE` only when that team already
  exists (the script never creates it). Anything else is listed and skipped;
  force a mapping with `--map PROJECT=TEAM`. Existing map entries are never
  overwritten.
- It is safe to re-run: a second `--apply` changes nothing.

## Security notes

- The webhook URL is a credential. Reverse proxies and platform logs usually
  record request paths, so a leaked access log leaks the URL. Redact
  `/webhooks/glitchtip/` in proxy logs where you can, and rotate if in doubt.
  The API itself does not log request paths for this route.
- A leaked URL can only create or bump issues in the mapped teams, capped at 25
  per delivery and 256 KB per body. Disabling or rotating the integration stops
  it at once.
- Alert text is untrusted. The body of an issue is rendered as plain lines with
  backticks, angle brackets and `@` stripped from payload values, and links are
  accepted only when they are `https` on the GlitchTip host seen in the first
  accepted alert.
