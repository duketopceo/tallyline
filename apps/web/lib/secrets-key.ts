// The API answers 503 SECRETS_KEY_MISSING when it has no AUTH_SECRET_KEY to
// seal provider secrets with. That is an operator problem, not a failed save,
// so the panels show a callout naming the variable instead of a bare toast.

export const SECRETS_KEY_CODE = "SECRETS_KEY_MISSING";
export const SECRETS_KEY_VAR = "AUTH_SECRET_KEY";

export interface ApiFailure {
  code?: string | undefined;
  message: string;
}

/** The machine-readable code plus the human message from an API error body. */
export async function apiFailure(
  res: Response,
  fallback: string,
): Promise<ApiFailure> {
  const body = (await res.clone().json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const message = body?.error?.message;
  return {
    code: body?.error?.code,
    message: message && message.trim() ? message : fallback,
  };
}

export function isSecretsKeyMissing(
  failure: ApiFailure | null | undefined,
): boolean {
  return failure?.code === SECRETS_KEY_CODE;
}

export const SECRETS_KEY_CALLOUT = {
  title: `Server needs ${SECRETS_KEY_VAR} to store provider keys`,
  body:
    `This install has no ${SECRETS_KEY_VAR}, so API keys and sign-in client ` +
    `secrets cannot be sealed. Ask whoever runs the server to set ` +
    `${SECRETS_KEY_VAR} to a random value (openssl rand -base64 32) that ` +
    `differs from JWT_SECRET, then restart the API. Saving works again with ` +
    `no other change.`,
} as const;
