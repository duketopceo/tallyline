# @tallyline/intake-client

Report an error, a bug or a help request from your app into a Tallyline
workspace. The client posts to `POST /v1/intake/:key` with the per-project
intake key you minted in **Settings → Intake** and nothing else — no
dependencies, no globals read, no fields added.

```bash
pnpm add @tallyline/intake-client
```

## What it posts

Exactly the fields you pass, validated by the server
(`apps/api/src/routes/intake-public.ts`):

| Field | Notes |
|---|---|
| `kind` | `error`, `bug`, `help` or `issue` |
| `title` | 1–500 characters |
| `body` | plain text, up to 100 KB |
| `provider` | a label for your app; the server defaults to `intake` |
| `fingerprint` | your error identity; repeats fold onto one issue |
| `externalId` | your delivery id; a replay is dropped, and a dedupe answer returns it |
| `url` | `https://` only |
| `severity` | `fatal`, `error`, `warning` or `info` |
| `occurredAt` | ISO string |
| `payload` | JSON object kept on the intake event (16 KB on the server) |
| `reporter` | `{ email?, name?, followUp? }` to get a follow-up handle back |

`report()` resolves to one of:

```ts
{ status: "sent", httpStatus, created, issueKey, reporterToken, deduped }
{ status: "dropped" }                                  // beforeSend cancelled it
{ status: "failed", httpStatus, code }                 // code is the server's
```

## Client

```ts
import { createClient } from "@tallyline/intake-client";

const intake = createClient({
  key: process.env.TALLY_INTAKE_KEY!,              // tlintake_…
  endpoint: "https://api.tallyline.app",           // omit in a browser: same origin
  beforeSend: (event) => {
    // scrub what should never leave your process; return null to drop it
    if (event.payload?.email) delete event.payload.email;
    return event;
  },
});

const result = await intake.report({
  kind: "error",
  title: error.message,
  body: error.stack,
  externalId: incidentId,     // your identity, kept verbatim
  severity: "error",
});
```

`beforeSend` may be async. Returning `null` sends nothing.

### Options

| Option | Default | Purpose |
|---|---|---|
| `key` | — | the intake key; required |
| `endpoint` | `""` | API origin; `""` posts relative to the page in a browser |
| `fetch` | `globalThis.fetch` | inject a transport (tests, proxies) |
| `beforeSend` | — | scrub or drop before the payload is serialised |
| `maxRetries` | `2` | extra attempts after a `429` |
| `maxRetryDelayMs` | `60000` | ceiling for one `Retry-After` wait |
| `sleep`, `now` | `setTimeout`, `Date.now` | test seams |

### Retries

A `429` is retried only when the response carries a readable `Retry-After`
(delta-seconds or HTTP-date), at most `maxRetries` times. `401`, `410`, `413`
and other refusals are final and returned as `{ status: "failed" }`. Network
failures are not retried; they return `httpStatus: 0, code: "NETWORK_ERROR"`.

### No data added

The body is `JSON.stringify` of the event you passed (after `beforeSend`). The
client never invents a fingerprint, a timestamp, a `provider`, a URL, a user
agent or an environment. Identity in Tallyline is therefore the identity you
sent, which is also what your support tooling keys on.

## React error boundary

```tsx
import { Component, type ErrorInfo, type ReactNode } from "react";
import { init } from "@tallyline/intake-client";
import { captureGlobalErrors } from "@tallyline/intake-client/browser";

// once, at startup — both entries share one module-level client
const intake = init({
  key: import.meta.env.VITE_TALLY_INTAKE_KEY,
  endpoint: "https://api.tallyline.app",
  beforeSend: (event) => ({
    ...event,
    payload: { componentStack: event.payload?.componentStack, route: location.pathname },
  }),
});
captureGlobalErrors(intake); // window.onerror + unhandled rejections

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // report() resolves; it never throws at a render path
    void intake.report({
      kind: "error",
      title: error.message,
      body: error.stack,
      severity: "fatal",
      externalId: crypto.randomUUID(),
      payload: { componentStack: info.componentStack ?? undefined },
    });
  }

  render() {
    return this.state.failed ? <p>Something broke. It has been reported.</p> : this.props.children;
  }
}
```

## Express

```ts
import express from "express";
import { createClient } from "@tallyline/intake-client";

const intake = createClient({
  key: process.env.TALLY_INTAKE_KEY!,
  endpoint: "https://api.tallyline.app",
  beforeSend: (event) => ({ ...event, reporter: undefined }), // drop request PII
});

const app = express();

app.use((error, req, res, next) => {
  void intake.report({
    kind: "error",
    title: error.message,
    body: error.stack,
    severity: "error",
    url: `${req.protocol}://${req.get("host")}${req.originalUrl}`,
    externalId: req.get("x-request-id"),
    payload: { method: req.method, status: 500 },
  });
  res.status(500).json({ error: "internal_error" });
});
```

## Plain fetch (browser)

```ts
const response = await fetch(`${API}/v1/intake/${TALLY_INTAKE_KEY}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    kind: "bug",
    title: "Export button does nothing",
    body: "Safari 18, /reports",
    externalId: crypto.randomUUID(),
  }),
});

if (response.status === 429) {
  const wait = Number(response.headers.get("retry-after") ?? "0");
  // requeue after `wait` seconds rather than hammering the key
}
```

## curl

```bash
curl -sS -X POST "$API/v1/intake/$TALLY_INTAKE_KEY" \
  -H 'content-type: application/json' \
  -d '{
        "kind": "bug",
        "title": "Checkout hangs",
        "body": "Steps:\n1. open cart",
        "externalId": "incident_2026_11_03",
        "severity": "error"
      }'
# -> {"issueKey":"ENG-42","reporterToken":null,"deduped":false}
```

## Correlation: pass your own `externalId`

Tallyline scopes `externalId` and `fingerprint` to the intake key. Send the id
your own tooling already uses (an incident id, a delivery id, a support ticket
number) so a Tallyline issue and your record can be matched without a lookup
table. A replay of the same `externalId` is answered with `deduped: true`
instead of filing a second issue.

Server-side behaviour, the reporter follow-up handle and the Sentry/GlitchTip
receivers are documented in [`docs/intake.md`](../../docs/intake.md).
