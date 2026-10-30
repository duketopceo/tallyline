import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EnvLike } from "../config.js";
import { COMPOSE_TEMPLATE } from "./compose.js";
import type { Sys } from "./sys.js";

// The install folder (~/.tallyline): compose.yml, .env (secrets, 0600), state.json,
// backups/. Writes are atomic and idempotent so an interrupted setup resumes.

export const DEFAULT_WEB_PORT = 3100;
export const DEFAULT_API_PORT = 4000;

export interface InstallState {
  /** release the running images were pulled from */
  version: string;
  /** the release before the last update, for rollback */
  previousVersion?: string;
  webPort: number;
  apiPort: number;
  createdAt: string;
  /** set when the person confirmed the secrets are saved somewhere safe */
  secretsSavedAt?: string;
}

export function installDir(env: EnvLike, flagDir?: string): string {
  if (flagDir) return flagDir;
  if (env.TALLYLINE_HOME) return env.TALLYLINE_HOME;
  return join(env.HOME ?? homedir(), ".tallyline");
}

export const paths = (dir: string) => ({
  compose: join(dir, "compose.yml"),
  env: join(dir, ".env"),
  state: join(dir, "state.json"),
  backups: join(dir, "backups"),
  marker: join(dir, "backups", ".last-backup"),
});

async function readOr(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writePrivate(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

export async function readState(dir: string): Promise<InstallState | undefined> {
  const raw = await readOr(paths(dir).state);
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as InstallState;
    return typeof s.version === "string" && typeof s.webPort === "number" ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(dir: string, s: InstallState): Promise<void> {
  await writePrivate(paths(dir).state, `${JSON.stringify(s, null, 2)}\n`);
}

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m?.[1] !== undefined) out[m[1]] = m[2] ?? "";
  }
  return out;
}

export async function readEnvFile(dir: string): Promise<Record<string, string>> {
  return parseEnv((await readOr(paths(dir).env)) ?? "");
}

export const SECRET_KEYS = ["POSTGRES_PASSWORD", "JWT_SECRET", "AUTH_SECRET_KEY"] as const;

export function serializeEnv(v: Record<string, string>): string {
  const keys = Object.keys(v);
  return `# Written by tallyline setup. Contains secrets: keep it private and keep a copy somewhere safe.\n${keys.map((k) => `${k}=${v[k]}`).join("\n")}\n`;
}

/**
 * Creates the install folder. Existing secrets are never regenerated: a second run,
 * or a run that was interrupted after this step, reuses what is already there.
 */
export async function ensureInstall(opts: {
  dir: string;
  sys: Sys;
  version: string;
  webPort: number;
  apiPort: number;
}): Promise<{ created: boolean; env: Record<string, string> }> {
  const p = paths(opts.dir);
  await mkdir(p.backups, { recursive: true, mode: 0o700 });
  await chmod(opts.dir, 0o700);
  const existing = await readEnvFile(opts.dir);
  const created = SECRET_KEYS.some((k) => !existing[k]);
  const env: Record<string, string> = {
    POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD || opts.sys.randomHex(16),
    JWT_SECRET: existing.JWT_SECRET || opts.sys.randomHex(32),
    AUTH_SECRET_KEY: existing.AUTH_SECRET_KEY || opts.sys.randomBase64(32),
    TALLYLINE_IMAGE_TAG: existing.TALLYLINE_IMAGE_TAG || opts.version,
    WEB_PUBLISH_PORT: String(opts.webPort),
    API_PUBLISH_PORT: String(opts.apiPort),
    API_BASE_URL: `http://localhost:${opts.apiPort}`,
    WEB_URL: `http://localhost:${opts.webPort}`,
  };
  await writePrivate(p.env, serializeEnv(env));
  await writeFile(p.compose, COMPOSE_TEMPLATE, { mode: 0o644 });
  if (!(await readState(opts.dir))) {
    await writeState(opts.dir, {
      version: env.TALLYLINE_IMAGE_TAG ?? opts.version,
      webPort: opts.webPort,
      apiPort: opts.apiPort,
      createdAt: new Date(opts.sys.now()).toISOString(),
    });
  }
  return { created, env };
}
