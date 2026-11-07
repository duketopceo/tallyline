import { OpenRouterError } from "@openrouter/sdk/models/errors";
import { decryptSecret, encryptSecret } from "../auth/secrets.js";
import { config_, DEFAULT_LLM_MODEL } from "../env.js";
import { AiError, DEFAULT_MONTHLY_CAP_CENTS, MAX_MONTHLY_CAP_CENTS, openRouterClient, saveProvider } from "./ai-providers.js";
import { clock } from "./clock.js";

// S3-U3: connect OpenRouter with its OAuth PKCE flow instead of a pasted key.
//
// Stateless by design: the PKCE verifier, workspace, person, chosen model and
// cap are sealed (AES-256-GCM, AUTH_SECRET_KEY) into the `state` value. In the
// browser flow OpenRouter hands `state` back on the callback; in headless mode
// (CLI over ssh) the caller keeps it and sends it back with the pasted code.
// Nothing is stored until the exchange succeeds, and a sealed state is only
// good for the workspace and person that started it, for ten minutes (the life
// of an OpenRouter code).

export const CONNECT_TTL_MS = 10 * 60_000;
/** same default the server-wide env provider uses */
export const DEFAULT_OPENROUTER_MODEL = DEFAULT_LLM_MODEL;

export type ConnectMode = "redirect" | "headless";

interface SealedState {
  v: 1;
  ws: string;
  user: string;
  verifier: string;
  model: string;
  capCents: number;
  mode: ConnectMode;
  exp: number;
}

function secretKey(): string {
  if (!config_.authSecretKey) {
    throw new AiError(
      503,
      "SECRETS_KEY_MISSING",
      "this server has no AUTH_SECRET_KEY, so it can't store an API key safely; ask whoever runs it to set one",
    );
  }
  return config_.authSecretKey;
}

const b64url = (b: Buffer) => b.toString("base64url");

export function callbackUrl(): string {
  return `${config_.webUrl}/settings/ai/openrouter`;
}

export interface StartInput {
  workspaceId: string;
  userId: string;
  mode: ConnectMode;
  model?: string | undefined;
  monthlyCapCents?: number | undefined;
}

export async function startOpenRouterConnect(input: StartInput): Promise<{ authUrl: string; state: string; expiresAt: string }> {
  const cap = input.monthlyCapCents ?? DEFAULT_MONTHLY_CAP_CENTS;
  if (cap < 0 || cap > MAX_MONTHLY_CAP_CENTS) {
    throw new AiError(422, "BAD_CAP", "the monthly limit must be between $0 and $10,000");
  }
  // SDK PKCE helpers: S256 challenge + a fresh RFC 7636 verifier
  const { codeChallenge, codeVerifier: verifier } = await openRouterClient("-").oAuth.createSHA256CodeChallenge();
  const exp = clock.now().getTime() + CONNECT_TTL_MS;
  const sealed: SealedState = {
    v: 1,
    ws: input.workspaceId,
    user: input.userId,
    verifier,
    model: (input.model ?? DEFAULT_OPENROUTER_MODEL).trim(),
    capCents: cap,
    mode: input.mode,
    exp,
  };
  const state = b64url(Buffer.from(encryptSecret(JSON.stringify(sealed), secretKey()), "utf8"));
  const url = new URL(
    await openRouterClient("-").oAuth.createAuthorizationUrl({
      callbackUrl: callbackUrl(),
      codeChallenge,
      codeChallengeMethod: "S256",
    }),
  );
  url.searchParams.set("key_label", "Tallyline");
  // headless (CLI over ssh): no browser callback, the person pastes the code back
  if (input.mode === "redirect") url.searchParams.set("state", state);
  else url.searchParams.delete("callback_url");
  return { authUrl: url.toString(), state, expiresAt: new Date(exp).toISOString() };
}

function openState(state: string, workspaceId: string, userId: string): SealedState {
  let parsed: SealedState;
  try {
    const blob = Buffer.from(state, "base64url").toString("utf8");
    parsed = JSON.parse(decryptSecret(blob, secretKey())) as SealedState;
  } catch {
    throw new AiError(400, "CONNECT_STATE_INVALID", "this sign-in link isn't valid; start Connect OpenRouter again");
  }
  if (parsed.v !== 1 || parsed.ws !== workspaceId || parsed.user !== userId) {
    // a state minted for another workspace or person: same answer, no detail
    throw new AiError(400, "CONNECT_STATE_INVALID", "this sign-in link isn't valid; start Connect OpenRouter again");
  }
  if (clock.now().getTime() > parsed.exp) {
    throw new AiError(410, "CONNECT_EXPIRED", "the OpenRouter sign-in took longer than 10 minutes; start again");
  }
  return parsed;
}

export interface CompleteConnectInput {
  workspaceId: string;
  userId: string;
  code: string;
  state: string;
}

export async function completeOpenRouterConnect(input: CompleteConnectInput): Promise<{ model: string }> {
  const st = openState(input.state, input.workspaceId, input.userId);
  let key: string;
  try {
    const r = await openRouterClient("-").oAuth.exchangeAuthCodeForAPIKey({
      requestBody: { code: input.code, codeVerifier: st.verifier, codeChallengeMethod: "S256" },
    });
    key = r.key;
  } catch (e) {
    if (e instanceof OpenRouterError) {
      if (e.statusCode === 400 || e.statusCode === 403 || e.statusCode === 404) {
        throw new AiError(
          400,
          "CONNECT_CODE_REJECTED",
          "OpenRouter didn't accept that code (it may be used, expired or mistyped); start again",
        );
      }
      throw new AiError(502, "OPENROUTER_ERROR", `OpenRouter answered ${e.statusCode}; try again in a minute`);
    }
    throw new AiError(502, "OPENROUTER_UNREACHABLE", "OpenRouter didn't answer; try again in a minute");
  }
  if (typeof key !== "string" || key.length < 8) {
    throw new AiError(502, "OPENROUTER_ERROR", "OpenRouter's answer had no key; try again");
  }
  await saveProvider(input.workspaceId, input.userId, {
    kind: "openrouter",
    label: "OpenRouter",
    model: st.model,
    apiKey: key,
    monthlyCapCents: st.capCents,
  });
  return { model: st.model };
}
