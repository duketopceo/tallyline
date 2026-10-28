# LLM assist

Opt-in model-backed helpers. Off by default — no `TALLYLINE_LLM_API_KEY`, no
LLM calls, and every assist surface returns `503 LLM_DISABLED`.

## Config

```bash
TALLYLINE_LLM_API_KEY=sk-or-…            # OpenRouter (or compatible) key
TALLYLINE_LLM_BASE_URL=https://openrouter.ai/api/v1
TALLYLINE_LLM_MODEL=google/gemini-2.5-flash-lite
```

The provider speaks OpenAI-style `POST /chat/completions`, so any compatible
endpoint works (OpenRouter, a local llama.cpp server, a proxy). Default model
is deliberately cheap; set `TALLYLINE_LLM_MODEL` to whatever fits your budget.

## Surfaces

All advisory — nothing mutates issues:

| Endpoint | Purpose |
|---|---|
| `GET /v1/:ws/llm/status` | `{enabled, model}` — the UI uses this to hide assist controls |
| `POST /v1/:ws/issues/:key/summarize` | 2–3 sentence summary of title + description + recent comments |
| `POST /v1/:ws/issues/:key/triage-suggest` | `{action: accept\|decline, reason}` triage verdict |
| `POST /v1/:ws/issues/dup-check` | `{title, description?}` → likely duplicate open issues |
| `POST /v1/:ws/issues?dupCheck=1` | same detection, attached to create as `possibleDuplicates` |

Issue detail renders a `✦ summarize` button only when the status endpoint
reports `enabled`. Upstream failures surface as `502 LLM_UPSTREAM`;
unparseable model output as `502 LLM_BAD_RESPONSE`.

## Provider seam

`services/llm.ts` defines `LLMProvider` (`complete({system, user, …})`).
`createOpenRouterProvider()` is plain fetch — no SDK. A second provider
(local model, Perplexity, a gateway) implements the same interface and
plugs into `createAssist(provider)`.

## Bring your own provider (per workspace)

An owner or admin can connect the workspace's own AI provider instead of (or on
top of) the server-wide `TALLYLINE_LLM_*` environment. No server restart, no
environment variables:

| Endpoint | Purpose |
|---|---|
| `GET /v1/workspaces/:ws/ai/provider` | the connected provider (or the server-wide one, `source: "environment"`), plus this month's spend. Never returns the key, only `hasKey` |
| `PUT /v1/workspaces/:ws/ai/provider` | connect or change it. `kind` is `openrouter` or `openai_compatible` (any `/chat/completions` server: OpenAI, Ollama, LM Studio, vLLM, a gateway) |
| `DELETE /v1/workspaces/:ws/ai/provider` | disconnect |
| `POST /v1/workspaces/:ws/ai/provider/test` | one tiny real call; answers `{ok, message}` in plain words. 6 per minute |
| `GET /v1/workspaces/:ws/ai/usage` | this month's spend and the most recent calls |

How it behaves:

- **The key is sealed at rest** (AES-256-GCM with `AUTH_SECRET_KEY`) and is never
  returned, logged, or put in the audit trail. Send `apiKey` to set it, omit it
  to keep it, send `""` to remove it. Without `AUTH_SECRET_KEY` the server
  refuses to store a key (`503 SECRETS_KEY_MISSING`) rather than store it in the clear.
- **A monthly limit stops calls before they are made.** The default is $10; set
  `monthlyCapCents` (or `null` for no limit). Reaching it answers `402
  AI_CAP_REACHED` until an admin raises it or the month rolls over (UTC).
  Spend comes from the cost OpenRouter reports for each call; other providers
  report tokens only, so their calls are counted but not priced.
- **Same outbound policy as webhooks.** Addresses must be `https` and public.
  Loopback, link-local (cloud metadata) and private ranges are refused at save
  time and again at connect time, redirects are not followed and responses are
  size-capped. A server on a private network (a home lab running Ollama) opts in
  once, for everyone, with `TALLYLINE_WEBHOOK_ALLOW_PRIVATE=1`; individual
  workspaces can't open that door on a shared server.
- **Errors say what to do**, and never include the key or the provider's raw
  reply: "it didn't accept the API key", "the account is out of credit", "it
  doesn't know that model".

This release adds the provider store, the spend ledger and the connect/test API.
The existing assist surfaces above still read the server-wide environment until
they are moved onto the workspace provider.
