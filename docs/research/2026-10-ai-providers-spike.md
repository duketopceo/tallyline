# AI providers spike (S3-U1)

Date: 2026-10-30. Read-only research. No forms submitted, no production calls.

Scope from the plan: (1) OpenRouter PKCE, including headless paste-code mode;
(2) what interface Hermes exposes; (3) whether Tallyline can use a person's
ChatGPT plan ("Sign in with ChatGPT"). Output: a decision on S3-U5.

## Summary

| Question | Answer | Confidence |
|---|---|---|
| OpenRouter PKCE fits Tallyline | Yes. Built in S3-U3 (#200) | High |
| Headless mode for the CLI | Yes. Omit `callback_url`; OpenRouter shows the code | High |
| Hermes connects without new code | Yes, as an OpenAI-compatible endpoint | High |
| ChatGPT plan provider (S3-U5) | Not now. Deferred until the maintainer decides on the interest form | Moderate |

## 1. OpenRouter PKCE

Source: [OpenRouter OAuth PKCE guide](https://openrouter.ai/docs/guides/overview/auth/oauth).

- Flow: send the user to `https://openrouter.ai/auth` with `code_challenge`
  and `code_challenge_method=S256`, then POST `{code, code_verifier,
  code_challenge_method}` to `https://openrouter.ai/api/v1/auth/keys`. The
  answer is `{ "key": "..." }`.
- `callback_url` is optional. Without it OpenRouter shows the code on screen
  for the user to copy. The code is single-use and expires after 10 minutes.
- The key belongs to the approving user's OpenRouter account and spends their
  credits. The docs list no key limits, so Tallyline's own monthly limit
  (S3-U2) stays the spending guard.

What Tallyline built (S3-U3): the verifier never leaves the server unsealed.
It sits inside a `state` sealed with `AUTH_SECRET_KEY`, bound to the workspace
and the person who started, valid for 10 minutes. Web uses the redirect; the
CLI uses headless mode. Not yet done: one live run on a capped account (listed
under "needs Luke" in the roadmap).

## 2. Hermes

Assumed to be [Hermes Agent by Nous Research](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server).
Open question 5 (which Hermes) is still unanswered, so the plan's default
applies: treat it as any OpenAI-compatible URL.

- Hermes Agent's API server serves `POST /v1/chat/completions`, the same call
  Tallyline makes ([programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)).
- It is off by default. Enable it with `API_SERVER_ENABLED=true` and a bearer
  `API_SERVER_KEY`. It listens on `http://127.0.0.1:8642` and advertises the
  model `hermes-agent` ([environment reference](https://hermes-agent.nousresearch.com/docs/reference/environment-variables)).

How to connect it today, no code change: Settings > AI > Use another endpoint,
base URL `http://<host>:8642/v1`, model `hermes-agent`, key = `API_SERVER_KEY`.
Plain http to a private address only works when the Tallyline server sets
`TALLYLINE_WEBHOOK_ALLOW_PRIVATE` (the SSRF policy). Over the public internet,
put Hermes behind https.

Caveat: Hermes answers with its full agent loop (tools, memory). A summary
request may be slower and costlier than a plain model. Keep the monthly limit
low the first time.

## 3. ChatGPT plan ("Sign in with ChatGPT" plan usage)

Sources: [overview](https://developers.openai.com/siwc/token-sharing-open-source),
[registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[help article](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).

What the docs say:

- Plan usage is an optional scope on top of Sign in with ChatGPT. The docs
  cover "open-source and locally hosted apps". Paid or remotely hosted apps
  must fill in an interest form first.
- Registration is dynamic: start with `client_id=dynamic_agent_client`, a
  stable per-host `ext_agent_host_id`, PKCE, state and nonce. The issued
  `client_id` is bound to one user and one workspace.
- Requests go to the Responses API with `store: false` and `stream: true`.
  `temperature`, `max_output_tokens`, `metadata` and system-role items are
  rejected. The app must refresh the OAuth token itself.
- For users, plan sharing needs a Go, Plus or Pro plan. It counts against the
  plan's included usage.

Why Tallyline doesn't fit cleanly:

1. A Tallyline server is shared by a team. One admin's plan would pay for
   every teammate's summaries. The docs bind a client to one user and say
   nothing about multi-user servers.
2. A self-hosted server that teammates reach over the network looks like
   "remotely hosted". That puts it on the interest-form path. Submitting forms
   is a stop condition in this program.
3. The wire format differs: Responses API, streaming only, no
   `temperature` or token cap. Tallyline's seam is Chat Completions with a
   token cap. A third code path would be needed.

Decision: S3-U5 stays deferred. Revisit if the maintainer submits the interest
form and OpenAI confirms that a shared self-hosted server is allowed. Until
then, people who want OpenAI models use an OpenAI API key through the
compatible-endpoint form, or OpenRouter.

## Follow-ups

- Needs Luke: answer open question 4 (submit the OpenAI interest form or not)
  and question 5 (confirm which Hermes).
- Needs Luke: one live Connect OpenRouter run on a capped account.
