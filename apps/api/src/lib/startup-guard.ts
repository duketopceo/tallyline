// Refuses to boot in production with a missing, empty, short or
// well-known dev-default secret. Pure so it can be unit tested; env.ts calls
// it once at import time with the real environment.

export const DEV_JWT_SECRET = "tallyline-dev-secret-change-me";
const MIN_SECRET_LENGTH = 32;

const KNOWN_WEAK = new Set([
  DEV_JWT_SECRET,
  "tallyline-dev-secret-change-me",
  "change-me",
  "changeme",
  "secret",
]);

export class StartupGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupGuardError";
  }
}

export interface GuardInput {
  nodeEnv: string | undefined;
  jwtSecret: string | undefined;
  authSecretKey: string | undefined;
}

export function isProduction(nodeEnv: string | undefined): boolean {
  return nodeEnv === "production";
}

function weak(name: string, value: string): string | null {
  if (KNOWN_WEAK.has(value.trim().toLowerCase()) || KNOWN_WEAK.has(value)) {
    return `${name} is set to a known default value`;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} is shorter than ${MIN_SECRET_LENGTH} characters`;
  }
  return null;
}

export function assertProductionSecrets(input: GuardInput): void {
  if (!isProduction(input.nodeEnv)) return;
  const problems: string[] = [];

  const jwt = input.jwtSecret;
  if (jwt === undefined || jwt.trim() === "") {
    problems.push("JWT_SECRET is unset or empty");
  } else {
    const w = weak("JWT_SECRET", jwt);
    if (w) problems.push(w);
  }

  // AUTH_SECRET_KEY is optional (empty = DB-stored provider secrets are off),
  // but when present it must be strong and distinct from JWT_SECRET.
  const key = input.authSecretKey;
  if (key !== undefined && key.trim() !== "") {
    const w = weak("AUTH_SECRET_KEY", key);
    if (w) problems.push(w);
    else if (key === jwt) {
      problems.push("AUTH_SECRET_KEY must differ from JWT_SECRET");
    }
  }

  if (problems.length > 0) {
    throw new StartupGuardError(
      `refusing to start in production: ${problems.join("; ")}. ` +
        `Generate each with \`openssl rand -hex 32\` and set it in the environment.`,
    );
  }
}

/**
 * AUTH_SECRET_KEY stays optional, but without it provider keys and sign-in
 * client secrets cannot be sealed: the UI answers 503 SECRETS_KEY_MISSING.
 * One warning at boot names the variable before an operator hits that.
 */
export function providerSecretsWarning(input: GuardInput): string | null {
  if (!isProduction(input.nodeEnv)) return null;
  if (input.authSecretKey && input.authSecretKey.trim() !== "") return null;
  return (
    "AUTH_SECRET_KEY is unset: AI provider keys and sign-in client secrets " +
    "cannot be stored (the settings panel will answer SECRETS_KEY_MISSING). " +
    "Set it to a random value that differs from JWT_SECRET and restart. " +
    "See docs/deploy.md."
  );
}

export function warnMissingProviderSecrets(
  input: GuardInput,
  log: (message: string) => void = console.warn,
): void {
  const warning = providerSecretsWarning(input);
  if (warning) log(warning);
}
