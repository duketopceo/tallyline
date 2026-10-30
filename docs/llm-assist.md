# LLM assist

Opt-in model-backed helpers. Off by default. Each call runs on the workspace's
own provider (Settings > AI) or, if it has none, the server's
`TALLYLINE_LLM_*` provider. With neither, no model calls happen and every assist
surface returns `503 LLM_DISABLED` pointing at Settings > AI.

Every call goes through the same seam (`services/ai-seam.ts` →
`ai-providers.complete`), so the monthly limit is checked first (`402
AI_CAP_REACHED`) and a ledger row records the action, model and cost.

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
| `GET /v1/:ws/llm/status` | `{enabled, model, source}` — the UI uses this to hide assist controls |
| `POST /v1/:ws/issues/:key/summarize` | 2–3 sentence summary of title + description + recent comments |
| `POST /v1/:ws/issues/:key/triage-suggest` | `{action: accept\|decline, reason}` triage verdict |
| `POST /v1/:ws/issues/:key/breakdown-suggest` | `{subIssues: [{title, description}]}`, up to 8. Suggestions only; a person creates the ones they want (web: "Suggest sub-issues"; MCP: `suggest_sub_issues`) |
| `POST /v1/:ws/issues/dup-check` | `{title, description?}` → likely duplicate open issues |
| `POST /v1/:ws/issues?dupCheck=1` | same detection, attached to create as `possibleDuplicates` |

Issue detail renders a `✦ summarize` button only when the status endpoint
reports `enabled`. Provider failures surface as `502 AI_UPSTREAM` /
`AI_UNREACHABLE` with a plain reason the page shows as-is;
unparseable model output as `502 LLM_BAD_RESPONSE`.

## Provider seam

`services/llm.ts` defines `LLMProvider` (`complete({system, user, …})`).
`createAssist()` with no argument binds each call to the workspace through
`workspaceLLM(workspaceId, action)` in `services/ai-seam.ts`. Tests pass a stub
to `createAssist(provider)`; nothing else calls a model directly.

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
| `POST /v1/workspaces/:ws/ai/openrouter/start` | begin "Connect OpenRouter" (PKCE). Returns the sign-in URL and a sealed state |
| `POST /v1/workspaces/:ws/ai/openrouter/complete` | finish it: `{code, state}`. The key is fetched server-side and never shown |

### Connect OpenRouter without copying a key

Settings > AI > Connect OpenRouter sends you to OpenRouter, you approve, and you
land back on `/settings/ai/openrouter`. The server trades the one-time code for a
key and seals it. You never see or paste the key.

- The PKCE verifier lives only inside the sealed `state` (AES-256-GCM). The
  state only finishes for the person and workspace that started it, within 10
  minutes. The OpenRouter code itself is single-use.
- Headless (`tallyline ai connect openrouter`): the CLI prints the URL, you
  approve in any browser, then paste the code shown. No callback server needed.
- A used or wrong code answers `400 CONNECT_CODE_REJECTED`; an old state
  answers `410 CONNECT_EXPIRED`. Nothing is saved on failure.
- New connections start on `google/gemini-2.5-flash-lite` with a $10 monthly limit.

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

Every assist surface above runs on this workspace provider, so the monthly
limit and the usage ledger cover them too.
