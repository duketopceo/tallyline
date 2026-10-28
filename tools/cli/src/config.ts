import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnv } from "@tallyline/types";

export type EnvLike = Record<string, string | undefined>;

export interface CliConfig {
  apiUrl: string;
  token?: string;
  workspace?: string;
  agentId?: string;
  userId?: string;
}

interface FileConfig {
  apiUrl?: string;
  token?: string;
  workspace?: string;
  agentId?: string;
  userId?: string;
}

export interface ResolvedConfig {
  config: CliConfig;
  // config files that were actually read — useful for `init` and debugging
  files: string[];
}

const DEFAULT_API_URL = "http://localhost:4000";

function isFileConfig(value: unknown): value is FileConfig {
  return typeof value === "object" && value !== null;
}

async function readConfigFile(path: string): Promise<FileConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isFileConfig(parsed)) return null;
    return parsed;
  } catch {
    return null; // missing file or malformed JSON — treat as absent
  }
}

// Precedence (low -> high):
//   ~/.config/tallyline/config.json  <  ./.tallyline/config.json  <
//   ./.tallyline.json  <  env (TALLYLINE_*)  <  flags
export async function resolveConfig(opts: {
  env: EnvLike;
  cwd: string;
  flags?: { apiUrl?: string; token?: string; workspace?: string };
  /** consulted last, only when no flag, env var or file supplied a token */
  tokens?: { get(server: string): Promise<string | undefined> };
}): Promise<ResolvedConfig> {
  const home = opts.env.HOME ?? homedir();
  const candidates = [
    join(home, ".config", "tallyline", "config.json"),
    join(opts.cwd, ".tallyline", "config.json"),
    join(opts.cwd, ".tallyline.json"),
  ];

  const merged: FileConfig = {};
  const files: string[] = [];
  for (const path of candidates) {
    const cfg = await readConfigFile(path);
    if (!cfg) continue;
    files.push(path);
    for (const k of [
      "apiUrl",
      "token",
      "workspace",
      "agentId",
      "userId",
    ] as const) {
      if (typeof cfg[k] === "string" && cfg[k]) merged[k] = cfg[k];
    }
  }

  const env = opts.env;
  const config: CliConfig = {
    apiUrl: merged.apiUrl ?? DEFAULT_API_URL,
    ...(merged.token !== undefined ? { token: merged.token } : {}),
    ...(merged.workspace !== undefined
      ? { workspace: merged.workspace }
      : {}),
    ...(merged.agentId !== undefined ? { agentId: merged.agentId } : {}),
    ...(merged.userId !== undefined ? { userId: merged.userId } : {}),
  };


  const fromEnv = (name: string) => readEnv(env, name);
  const envApiUrl = fromEnv("TALLYLINE_API_URL");
  const envToken = fromEnv("TALLYLINE_TOKEN");
  const envWorkspace = fromEnv("TALLYLINE_WORKSPACE");
  const envAgentId = fromEnv("TALLYLINE_AGENT_ID");
  const envUserId = fromEnv("TALLYLINE_USER_ID");
  if (envApiUrl) config.apiUrl = envApiUrl;
  if (envToken) config.token = envToken;
  if (envWorkspace) config.workspace = envWorkspace;
  if (envAgentId) config.agentId = envAgentId;
  if (envUserId) config.userId = envUserId;

  if (opts.flags?.apiUrl) config.apiUrl = opts.flags.apiUrl;
  if (opts.flags?.token) config.token = opts.flags.token;
  if (opts.flags?.workspace) config.workspace = opts.flags.workspace;

  config.apiUrl = config.apiUrl.replace(/\/+$/, "");
  if (!config.token && opts.tokens) {
    const saved = await opts.tokens.get(config.apiUrl).catch(() => undefined);
    if (saved) config.token = saved;
  }
  return { config, files };
}

// ── saving settings ─────────────────────────────────────────────────────


export function globalConfigPath(env: EnvLike): string {
  return join(env.HOME ?? homedir(), ".config", "tallyline", "config.json");
}

export type Profile = Partial<Pick<CliConfig, "apiUrl" | "workspace" | "agentId">>;

// Merge into the global config file. Unknown keys survive, so a hand-edited or
// older file is never clobbered, and the token is never written here (it goes
// to the token store).
export async function saveProfile(env: EnvLike, patch: Profile): Promise<string> {
  const path = globalConfigPath(env);
  const current = (await readConfigFile(path)) ?? {};
  const next: Record<string, unknown> = { ...current, ...patch };
  delete next.token;
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  // writeFile only applies `mode` to a new file; tighten one that already existed
  await chmod(path, 0o600);
  return path;
}
