import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { CliError } from "../cli-error.js";
import type { EnvLike } from "../config.js";

// S3-U6: one flow that points a coding agent at this server's OAuth `/mcp`
// endpoint. Only the `tallyline` entry is ever added, replaced or removed;
// every other server and unknown key in the file is left as it was. The file
// is backed up before the first change and `undo` puts our entry back the way
// it was. No key is written: each agent signs in through the browser.
//
// Formats checked 2026-10-30 against each agent's docs:
//   Claude Code  .mcp.json            { mcpServers: { name: { type: "http", url } } }
//   Cursor       ~/.cursor/mcp.json   { mcpServers: { name: { url } } }
//   Codex        ~/.codex/config.toml [mcp_servers.name] url = "…"
//   opencode     ~/.config/opencode/opencode.json { mcp: { name: { type: "remote", url, enabled } } }

export const ENTRY = "tallyline";
export const HARNESS_IDS = ["claude", "codex", "cursor", "opencode"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];
export type Scope = "global" | "project";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type JsonObject = { [k: string]: Json };

export interface Harness {
  id: HarnessId;
  label: string;
  bins: string[];
  /** a folder whose presence means the agent has been used on this computer */
  homeMarker: string;
  format: "json" | "toml";
  /** JSON only: the key that holds the servers */
  serversKey?: "mcpServers" | "mcp";
  /** Claude Code keeps personal servers inside a large state file; we only write the project file */
  scopes: Scope[];
  path(scope: Scope, home: string, cwd: string): string;
  /** how the person signs in after the file is written */
  signIn: string;
}

export const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    bins: ["claude"],
    homeMarker: ".claude",
    format: "json",
    serversKey: "mcpServers",
    scopes: ["project"],
    path: (_s, _h, cwd) => join(cwd, ".mcp.json"),
    signIn: "Start Claude Code in this folder, type /mcp, pick tallyline and sign in.",
  },
  codex: {
    id: "codex",
    label: "Codex",
    bins: ["codex"],
    homeMarker: ".codex",
    format: "toml",
    scopes: ["global", "project"],
    path: (s, h, cwd) => (s === "project" ? join(cwd, ".codex", "config.toml") : join(h, ".codex", "config.toml")),
    signIn: "Run: codex mcp login tallyline",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    bins: ["cursor", "cursor-agent"],
    homeMarker: ".cursor",
    format: "json",
    serversKey: "mcpServers",
    scopes: ["global", "project"],
    path: (s, h, cwd) => (s === "project" ? join(cwd, ".cursor", "mcp.json") : join(h, ".cursor", "mcp.json")),
    signIn: "Open Cursor Settings, then MCP, and press Connect next to tallyline.",
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    bins: ["opencode"],
    homeMarker: join(".config", "opencode"),
    format: "json",
    serversKey: "mcp",
    scopes: ["global", "project"],
    path: (s, h, cwd) => (s === "project" ? join(cwd, "opencode.json") : join(h, ".config", "opencode", "opencode.json")),
    signIn: "Run: opencode mcp auth tallyline",
  },
};

export function isHarnessId(v: string): v is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(v);
}

export function homeOf(env: EnvLike): string {
  return env.HOME ?? homedir();
}

export function mcpUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/mcp`;
}

// --- detection ---------------------------------------------------------------

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function onPath(bin: string, env: EnvLike): Promise<boolean> {
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try {
      await access(join(d, bin), constants.X_OK);
      return true;
    } catch {
      // keep looking
    }
  }
  return false;
}

export async function detect(h: Harness, env: EnvLike): Promise<boolean> {
  for (const b of h.bins) if (await onPath(b, env)) return true;
  return exists(join(homeOf(env), h.homeMarker));
}

// --- entry shapes --------------------------------------------------------------

export function jsonEntry(h: Harness, url: string): JsonObject {
  if (h.id === "claude") return { type: "http", url };
  if (h.id === "opencode") return { type: "remote", url, enabled: true };
  return { url };
}

/** Codex: read and write only. The server never offers review to an agent. */
export function tomlBody(url: string): string[] {
  return [`url = ${JSON.stringify(url)}`, `scopes = ["read", "write"]`];
}

/** what a person pastes by hand when the agent is not installed */
export function snippet(h: Harness, url: string): string {
  if (h.format === "toml") return [`[mcp_servers.${ENTRY}]`, ...tomlBody(url)].join("\n");
  return JSON.stringify({ [h.serversKey ?? "mcpServers"]: { [ENTRY]: jsonEntry(h, url) } }, null, 2);
}

// --- JSON merge ------------------------------------------------------------------

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseJsonFile(text: string, path: string): JsonObject {
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CliError(
      1,
      `${path} is not plain JSON (it may have comments). Nothing was changed. Run 'tallyline agent connect <agent> --print' and add the entry by hand`,
    );
  }
  if (!isObject(v)) throw new CliError(1, `${path} does not hold a JSON object. Nothing was changed.`);
  return v;
}

function indentOf(text: string): string | number {
  const m = /^\{\s*\n([ \t]+)"/.exec(text);
  return m?.[1] ?? 2;
}

/** returns the new text and the entry that was there before (undefined if none) */
export function setJsonEntry(
  text: string,
  key: "mcpServers" | "mcp",
  entry: Json | undefined,
  path = "the config file",
): { text: string; previous: Json | undefined } {
  const doc = parseJsonFile(text, path);
  const servers = doc[key];
  if (servers !== undefined && !isObject(servers)) {
    throw new CliError(1, `"${key}" in ${path} is not an object. Nothing was changed.`);
  }
  const box: JsonObject = servers ?? {};
  const previous = box[ENTRY];
  if (entry === undefined) delete box[ENTRY];
  else box[ENTRY] = entry;
  if (servers === undefined && entry !== undefined) doc[key] = box;
  return { text: `${JSON.stringify(doc, null, indentOf(text))}\n`, previous };
}

// --- TOML table edit -----------------------------------------------------------------
// Line-based on purpose: the file is never re-serialised, so comments and
// formatting elsewhere survive byte for byte.

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

function headerName(line: string): string | undefined {
  const m = HEADER.exec(line);
  if (!m?.[1]) return undefined;
  return m[1]
    .split(".")
    .map((p) => p.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .join(".");
}

const OURS = `mcp_servers.${ENTRY}`;
const isOurs = (name: string) => name === OURS || name.startsWith(`${OURS}.`);

/** our tables as raw text, or undefined; refuses shapes it can't edit safely */
function splitToml(text: string, path: string): { kept: string[]; ours: string[] } {
  const lines = text.split("\n");
  const kept: string[] = [];
  const ours: string[] = [];
  let table = "";
  for (const line of lines) {
    const name = headerName(line);
    if (name !== undefined) table = name;
    if (isOurs(table)) {
      ours.push(line);
      continue;
    }
    // dotted keys or inline tables defining our server outside its own table
    const dotted = table === "" && new RegExp(`^\\s*mcp_servers\\.("?)${ENTRY}\\1\\s*[.=]`).test(line);
    const inline = table === "mcp_servers" && new RegExp(`^\\s*("?)${ENTRY}\\1\\s*=`).test(line);
    if (dotted || inline) {
      throw new CliError(
        1,
        `${path} defines tallyline in a form this tool won't rewrite. Nothing was changed. Replace it by hand with: tallyline agent connect codex --print`,
      );
    }
    kept.push(line);
  }
  return { kept, ours };
}

export function setTomlTable(
  text: string,
  body: string[] | undefined,
  path = "the config file",
): { text: string; previous: string | undefined } {
  const { kept, ours } = splitToml(text, path);
  while (ours.length && ours.at(-1)!.trim() === "") ours.pop();
  const previous = ours.length ? ours.join("\n") : undefined;
  while (kept.length && kept.at(-1)!.trim() === "") kept.pop();
  const out = [...kept];
  if (body) {
    if (out.length) out.push("");
    out.push(`[${OURS}]`, ...body);
  }
  return { text: out.length ? `${out.join("\n")}\n` : "", previous };
}

/** put a previously saved TOML table back (raw text) */
export function restoreTomlTable(text: string, raw: string | undefined, path?: string): string {
  const cleared = setTomlTable(text, undefined, path).text;
  if (raw === undefined) return cleared;
  const base = cleared.replace(/\n+$/, "");
  return `${base ? `${base}\n\n` : ""}${raw}\n`;
}

// --- undo ledger --------------------------------------------------------------------

export interface UndoRecord {
  harness: HarnessId;
  path: string;
  /** file did not exist before we wrote it */
  created: boolean;
  backup?: string;
  /** JSON harnesses: the old entry; TOML: the old table text */
  previous?: Json | string;
  at: string;
}

function ledgerPath(env: EnvLike): string {
  return join(homeOf(env), ".config", "tallyline", "agent-connect.json");
}

async function readLedger(env: EnvLike): Promise<UndoRecord[]> {
  try {
    const v: unknown = JSON.parse(await readFile(ledgerPath(env), "utf8"));
    return Array.isArray(v) ? (v as UndoRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeLedger(env: EnvLike, recs: UndoRecord[]): Promise<void> {
  const p = ledgerPath(env);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, `${JSON.stringify(recs, null, 2)}\n`, { mode: 0o600 });
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${path}.tallyline-tmp`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

// --- connect / undo ------------------------------------------------------------------

export interface ConnectResult {
  path: string;
  created: boolean;
  replaced: boolean;
  backup?: string;
  changed: boolean;
}

export async function connectAgent(opts: {
  harness: Harness;
  scope: Scope;
  apiUrl: string;
  env: EnvLike;
  cwd: string;
  dryRun?: boolean;
  now?: () => Date;
}): Promise<ConnectResult & { text: string }> {
  const { harness: h, env } = opts;
  if (!h.scopes.includes(opts.scope)) {
    throw new CliError(2, `${h.label} is only set up per project here. Run this inside the project folder without --global.`);
  }
  const path = h.path(opts.scope, homeOf(env), opts.cwd);
  const before = await readMaybe(path);
  const url = mcpUrl(opts.apiUrl);
  let text: string;
  let previous: Json | string | undefined;
  if (h.format === "toml") {
    ({ text, previous } = setTomlTable(before ?? "", tomlBody(url), path));
  } else {
    ({ text, previous } = setJsonEntry(before ?? "", h.serversKey ?? "mcpServers", jsonEntry(h, url), path));
  }
  const changed = text !== before;
  const base = { path, created: before === undefined, replaced: previous !== undefined, changed, text };
  if (opts.dryRun || !changed) return base;

  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  let backup: string | undefined;
  if (before !== undefined) {
    backup = `${path}.tallyline-backup-${stamp}`;
    await copyFile(path, backup);
  }
  await atomicWrite(path, text);

  const ledger = (await readLedger(env)).filter((r) => !(r.harness === h.id && r.path === path));
  const rec: UndoRecord = { harness: h.id, path, created: before === undefined, at: stamp };
  if (backup) rec.backup = backup;
  if (previous !== undefined) rec.previous = previous;
  ledger.push(rec);
  await writeLedger(env, ledger);
  return backup ? { ...base, backup } : base;
}

/** restores only our entry to what it was; other edits since stay */
export async function undoAgent(opts: {
  harness: Harness;
  env: EnvLike;
  path?: string;
}): Promise<{ path: string; removedFile: boolean } | undefined> {
  const { harness: h, env } = opts;
  const ledger = await readLedger(env);
  let idx = -1;
  ledger.forEach((r, i) => {
    if (r.harness === h.id && (!opts.path || r.path === opts.path)) idx = i;
  });
  if (idx < 0) return undefined;
  const rec = ledger[idx]!;
  const now = await readMaybe(rec.path);
  let removedFile = false;
  if (now !== undefined) {
    let text: string;
    if (h.format === "toml") {
      text = restoreTomlTable(now, typeof rec.previous === "string" ? rec.previous : undefined, rec.path);
    } else {
      text = setJsonEntry(now, h.serversKey ?? "mcpServers", rec.previous as Json | undefined, rec.path).text;
    }
    const empty = h.format === "toml" ? text.trim() === "" : isEmptyShell(text, h.serversKey ?? "mcpServers");
    if (rec.created && empty) {
      await unlink(rec.path);
      removedFile = true;
    } else if (text !== now) {
      await atomicWrite(rec.path, text);
    }
  }
  ledger.splice(idx, 1);
  await writeLedger(env, ledger);
  return { path: rec.path, removedFile };
}

function isEmptyShell(text: string, key: string): boolean {
  const v: unknown = JSON.parse(text);
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return true;
  return keys.length === 1 && keys[0] === key && isObject(v[key]) && Object.keys(v[key]).length === 0;
}

/** true when the file on disk currently holds our entry pointing at `url` */
export async function isConnected(h: Harness, path: string, url: string): Promise<boolean> {
  const text = await readMaybe(path);
  if (text === undefined) return false;
  try {
    if (h.format === "toml") {
      const { ours } = splitToml(text, path);
      return ours.some((l) => l.includes(JSON.stringify(url)));
    }
    const doc = parseJsonFile(text, path);
    const box = doc[h.serversKey ?? "mcpServers"];
    const e = isObject(box) ? box[ENTRY] : undefined;
    return isObject(e) && e.url === url;
  } catch {
    return false;
  }
}
