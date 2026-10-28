import { ApiError, whoami, type FetchLike, type Whoami } from "./client.js";
import { CliError } from "./cli-error.js";
import type { CliIo, Command, CmdCtx } from "./commands.js";
import { globalConfigPath, resolveConfig, saveProfile, type EnvLike } from "./config.js";
import type { TokenStore } from "./secrets.js";
import { friendlyApiError } from "./ui/errors.js";
import { Cancelled, type Prompter } from "./ui/prompt.js";
import { errorBlock, nextSteps } from "./ui/render.js";

export const CLOUD_API = "https://api.tallyline.app";

export function normalizeServer(raw: string): string {
  let s = raw.trim();
  if (!s) throw new CliError(2, "server address is empty");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(s);
    s = `${local ? "http" : "https"}://${s}`;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new CliError(2, `'${raw}' is not a web address`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new CliError(2, "server address must start with https:// (or http:// for this computer)");
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** Best guess at where a person creates a token, for the "open this page" hint. */
export function tokenPageUrl(server: string): string | undefined {
  try {
    const u = new URL(server);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return `${u.protocol}//${u.hostname}:3100/settings/tokens`;
    if (u.hostname.startsWith("api.")) return `${u.protocol}//${u.hostname.slice(4)}/settings/tokens`;
  } catch {
    // fall through
  }
  return undefined;
}

export interface Connected {
  server: string;
  who: Whoami;
  workspace: string;
  keptIn: TokenStore["kind"];
}

// The whole sign-in, minus prompting: check the token really works, then keep
// it in the safest place available and remember the server and workspace.
export async function connectWith(opts: {
  server: string;
  token: string;
  workspace?: string | undefined;
  fetch: FetchLike;
  env: EnvLike;
  tokens: TokenStore;
}): Promise<Connected> {
  const server = normalizeServer(opts.server);
  const token = opts.token.trim();
  if (!token) throw new CliError(2, "token is empty");
  const who = await whoami(server, token, opts.fetch);
  const workspace = opts.workspace ?? who.workspaceSlug ?? undefined;
  if (!workspace) {
    throw new CliError(2, "this token isn't tied to a workspace; pass --workspace <slug>");
  }
  await opts.tokens.set(server, token);
  await saveProfile(opts.env, { apiUrl: server, workspace });
  const real = opts.tokens as TokenStore & { open?: () => Promise<TokenStore> };
  const kind = real.open ? (await real.open()).kind : opts.tokens.kind;
  return { server, who, workspace, keptIn: kind };
}

function tokensOf(io: CliIo): TokenStore {
  if (!io.tokens) throw new CliError(1, "no place to keep a sign-in on this system");
  return io.tokens;
}

async function readStdinToken(io: CliIo): Promise<string> {
  const raw = (await io.stdin?.()) ?? "";
  return raw.split(/\r?\n/)[0]?.trim() ?? "";
}

const keptNote = (k: TokenStore["kind"]) =>
  k === "file"
    ? "saved in a private file (this computer has no keychain)"
    : k === "macos-keychain"
      ? "saved in your Mac keychain"
      : "saved in your system keyring";

async function interactiveConnect(ctx: CmdCtx): Promise<void> {
  const p: Prompter | undefined = ctx.io.prompter;
  if (!p) throw new CliError(2, "connect needs a terminal; use --server and --token-stdin in scripts");
  const { config } = await resolveConfig({ env: ctx.io.env, cwd: ctx.io.cwd });
  const flagServer = typeof ctx.flags.server === "string" ? ctx.flags.server : undefined;
  p.intro("Connect to Tallyline");
  try {
    const server = normalizeServer(
      flagServer ??
        (await p.text({
          message: "Where is your Tallyline?",
          initial: config.token ? config.apiUrl : CLOUD_API,
          placeholder: CLOUD_API,
          validate: (v) => {
            try {
              normalizeServer(v || CLOUD_API);
              return undefined;
            } catch (e) {
              return e instanceof Error ? e.message : "that doesn't look like a web address";
            }
          },
        })),
    );
    const page = tokenPageUrl(server);
    p.note(
      page
        ? `1. Open ${page}\n2. Create a new token (read and write)\n3. Copy it and paste it below`
        : "In Tallyline, open Settings, then Tokens.\nCreate a new token (read and write), copy it, and paste it below.",
      "Get a sign-in token",
    );
    const token = await p.secret({
      message: "Paste your token (it stays hidden)",
      validate: (v) => (v.trim() ? undefined : "paste the token you just created"),
    });
    const spin = p.spin(`Checking with ${new URL(server).host}…`);
    let done: Connected;
    try {
      done = await connectWith({
        server,
        token,
        workspace: typeof ctx.flags.workspace === "string" ? ctx.flags.workspace : undefined,
        fetch: ctx.io.fetch,
        env: ctx.io.env,
        tokens: tokensOf(ctx.io),
      });
    } catch (err) {
      spin.fail("That didn't work");
      throw err;
    }
    spin.succeed(`Signed in as ${done.who.name} (${done.workspace})`);
    p.step("ok", `Token ${keptNote(done.keptIn)}`);
    p.step("ok", `Settings saved to ${globalConfigPath(ctx.io.env)}`);
    p.note(
      nextSteps([
        ["tallyline", "see where things stand"],
        ["tallyline ready", "pick something to work on"],
      ]).replace(/^Next\n/, ""),
      "Next",
    );
    p.outro("You're connected.");
  } catch (err) {
    if (err instanceof Cancelled) {
      p.outro("No changes made. Run tallyline connect whenever you're ready.");
      return;
    }
    throw err;
  }
}

export const connectCmd: Command = {
  usage:
    "tallyline connect [--server URL] [--workspace slug] [--token-stdin]",
  summary:
    "sign in: on a terminal it walks you through it; in scripts pipe the token in with --token-stdin (never as an argument)",
  options: {
    server: { type: "string" },
    "token-stdin": { type: "boolean" },
  },
  needsApi: false,
  run: async (ctx) => {
    const scripted = ctx.flags["token-stdin"] === true || ctx.io.isTTY !== true;
    if (!scripted) return interactiveConnect(ctx);
    const server = typeof ctx.flags.server === "string" ? ctx.flags.server : undefined;
    if (!server) throw new CliError(2, "--server <url> is required when not on a terminal");
    const token = await readStdinToken(ctx.io);
    if (!token) throw new CliError(2, "pipe the token on stdin, e.g. `printf %s \"$TOKEN\" | tallyline connect --server URL --token-stdin`");
    const done = await connectWith({
      server,
      token,
      workspace: typeof ctx.flags.workspace === "string" ? ctx.flags.workspace : undefined,
      fetch: ctx.io.fetch,
      env: ctx.io.env,
      tokens: tokensOf(ctx.io),
    });
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ server: done.server, workspace: done.workspace, user: done.who.name, storedIn: done.keptIn }));
    } else {
      ctx.io.out(`connected to ${done.server} as ${done.who.name} (${done.workspace}); token ${keptNote(done.keptIn)}`);
    }
  },
};

export const statusCmd: Command = {
  usage: "tallyline status [--json]",
  summary: "show which server and workspace you are connected to, and as whom",
  options: {},
  needsApi: false,
  run: async (ctx) => {
    const { config } = await resolveConfig({ env: ctx.io.env, cwd: ctx.io.cwd, ...(ctx.io.tokens ? { tokens: ctx.io.tokens } : {}) });
    const base = { server: config.apiUrl, workspace: config.workspace ?? null };
    if (!config.token) {
      if (ctx.json) ctx.io.out(JSON.stringify({ ...base, connected: false }));
      else if (ctx.io.isTTY === true) ctx.io.out("○ Not connected yet.\n\n" + nextSteps([["tallyline connect", "sign in to your Tallyline"]]));
      else ctx.io.out("not connected");
      return;
    }
    let who: Whoami;
    try {
      who = await whoami(config.apiUrl, config.token, ctx.io.fetch);
    } catch (err) {
      if (err instanceof ApiError && ctx.io.isTTY === true && !ctx.json) {
        ctx.io.out(errorBlock(friendlyApiError(err.status, err.code, err.message)));
        throw new CliError(err.status === 401 ? 3 : 1, "");
      }
      throw err;
    }
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ ...base, connected: true, user: who.name, type: who.type, role: who.role ?? null }));
      return;
    }
    if (ctx.io.isTTY === true) {
      ctx.io.out(`● Connected to ${new URL(config.apiUrl).host}\n  Signed in as ${who.name}${who.role ? ` (${who.role})` : ""}\n  Workspace   ${config.workspace ?? "—"}`);
    } else {
      ctx.io.out(`connected to ${config.apiUrl} as ${who.name} workspace=${config.workspace ?? ""}`);
    }
  },
};

export const disconnectCmd: Command = {
  usage: "tallyline disconnect [--yes]",
  summary: "forget the saved sign-in for the current server",
  options: { yes: { type: "boolean", short: "y" } },
  needsApi: false,
  run: async (ctx) => {
    const { config } = await resolveConfig({ env: ctx.io.env, cwd: ctx.io.cwd });
    if (ctx.io.isTTY === true && ctx.flags.yes !== true && ctx.io.prompter) {
      const ok = await ctx.io.prompter.confirm({
        message: `Forget your sign-in for ${new URL(config.apiUrl).host}?`,
        initial: false,
      });
      if (!ok) {
        ctx.io.out("Nothing changed.");
        return;
      }
    }
    await tokensOf(ctx.io).remove(config.apiUrl);
    ctx.io.out(ctx.io.isTTY === true ? "✔ Signed out. Your settings are kept; run tallyline connect to sign back in." : "disconnected");
  },
};

const CONFIG_KEYS: Record<string, "apiUrl" | "workspace" | "agentId"> = {
  server: "apiUrl",
  workspace: "workspace",
  agent: "agentId",
};

export const configCmd: Command = {
  usage: "tallyline config [path | get <key> | set <key> <value>]   keys: server, workspace, agent",
  summary: "see or change saved settings; with no arguments on a terminal it walks you through them",
  options: {},
  needsApi: false,
  run: async (ctx) => {
    const [sub, key, value] = ctx.args;
    if (sub === "path") {
      ctx.io.out(globalConfigPath(ctx.io.env));
      return;
    }
    const pick = (k: string | undefined) => {
      const f = k ? CONFIG_KEYS[k] : undefined;
      if (!f) throw new CliError(2, `unknown setting '${k ?? ""}' — one of ${Object.keys(CONFIG_KEYS).join(", ")}`);
      return f;
    };
    const { config } = await resolveConfig({ env: ctx.io.env, cwd: ctx.io.cwd });
    if (sub === "get") {
      ctx.io.out(config[pick(key)] ?? "");
      return;
    }
    if (sub === "set") {
      const f = pick(key);
      if (value === undefined) throw new CliError(2, "missing value");
      const v = f === "apiUrl" ? normalizeServer(value) : value;
      await saveProfile(ctx.io.env, { [f]: v });
      ctx.io.out(ctx.io.isTTY === true ? `✔ ${key} is now ${v}` : `${key}=${v}`);
      return;
    }
    if (sub !== undefined) throw new CliError(2, `unknown config command '${sub}'`);
    const p = ctx.io.prompter;
    if (ctx.io.isTTY !== true || !p) {
      for (const [k, f] of Object.entries(CONFIG_KEYS)) ctx.io.out(`${k}=${config[f] ?? ""}`);
      return;
    }
    p.intro("Settings");
    try {
      for (;;) {
        const k = await p.select({
          message: "What would you like to change?",
          options: [
            { value: "server", label: "Server", hint: config.apiUrl },
            { value: "workspace", label: "Workspace", hint: config.workspace ?? "not set" },
            { value: "agent", label: "My agent name", hint: config.agentId ?? "not set" },
            { value: "done", label: "Done" },
          ],
          initial: "done",
        });
        if (k === "done") break;
        const f = pick(k);
        const nv = await p.text({ message: `New ${k}`, initial: config[f] ?? "" });
        const v = f === "apiUrl" ? normalizeServer(nv) : nv.trim();
        await saveProfile(ctx.io.env, { [f]: v });
        config[f] = v;
        p.step("ok", `${k} saved`);
      }
      p.outro("Settings saved.");
    } catch (err) {
      if (err instanceof Cancelled) {
        p.outro("Stopped. Anything you already saved is kept.");
        return;
      }
      throw err;
    }
  },
};
