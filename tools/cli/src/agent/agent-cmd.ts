import { CliError } from "../cli-error.js";
import type { CmdCtx, Command } from "../commands.js";
import { mut } from "../pretty.js";
import {
  HARNESSES,
  HARNESS_IDS,
  connectAgent,
  detect,
  homeOf,
  isConnected,
  isHarnessId,
  mcpUrl,
  snippet,
  undoAgent,
  type Harness,
  type HarnessId,
  type Scope,
} from "./connect-agent.js";

// `tallyline agent` — connect Claude Code, Codex, Cursor or opencode to this
// server in one step (S3-U6). See docs/agents.md.

const USAGE =
  "tallyline agent [list | connect <claude|codex|cursor|opencode> [--project] [--dry-run] [--print] [--force] [--yes] | undo <agent>]";

function flag(ctx: CmdCtx, name: string): boolean {
  return ctx.flags[name] === true;
}

function emit(ctx: CmdCtx, v: unknown): void {
  ctx.io.out(JSON.stringify(v, null, 2));
}

async function pickHarness(ctx: CmdCtx, raw: string | undefined): Promise<Harness> {
  if (raw !== undefined) {
    const id = raw.toLowerCase();
    if (!isHarnessId(id)) throw new CliError(2, `unknown agent '${raw}'. Pick one of: ${HARNESS_IDS.join(", ")}`);
    return HARNESSES[id];
  }
  const p = ctx.io.prompter;
  if (!p) throw new CliError(2, `say which agent: ${HARNESS_IDS.join(", ")}`);
  const options: { value: HarnessId; label: string; hint?: string }[] = [];
  for (const id of HARNESS_IDS) {
    const h = HARNESSES[id];
    options.push({ value: id, label: h.label, ...((await detect(h, ctx.io.env)) ? { hint: "found on this computer" } : {}) });
  }
  return HARNESSES[await p.select({ message: "Which coding agent should use Tallyline?", options })];
}

function scopeFor(ctx: CmdCtx, h: Harness): Scope {
  if (flag(ctx, "project")) return "project";
  return h.scopes.includes("global") ? "global" : "project";
}

/** does the server answer as an OAuth-protected MCP endpoint? */
async function serverReady(ctx: CmdCtx): Promise<boolean> {
  try {
    const res = await ctx.io.fetch(new Request(`${ctx.cfg.apiUrl}/.well-known/oauth-protected-resource/mcp`));
    if (!res.ok) return false;
    const body = (await res.json()) as { resource?: unknown };
    return typeof body.resource === "string";
  } catch {
    return false;
  }
}

async function listRun(ctx: CmdCtx): Promise<void> {
  const url = mcpUrl(ctx.cfg.apiUrl);
  const rows: { agent: HarnessId; label: string; installed: boolean; connected: boolean; path: string }[] = [];
  for (const id of HARNESS_IDS) {
    const h = HARNESSES[id];
    const scope = scopeFor(ctx, h);
    const path = h.path(scope, homeOf(ctx.io.env), ctx.io.cwd);
    rows.push({ agent: id, label: h.label, installed: await detect(h, ctx.io.env), connected: await isConnected(h, path, url), path });
  }
  if (ctx.json) return emit(ctx, { server: url, agents: rows });
  ctx.io.out(`Tallyline for agents: ${url}`);
  for (const r of rows) {
    const state = r.connected ? "connected" : r.installed ? "found, not connected" : "not found";
    ctx.io.out(`  ${r.label.padEnd(12)} ${state.padEnd(22)} ${mut(r.path)}`);
  }
  ctx.io.out(mut("Connect one: tallyline agent connect <agent>"));
}

async function connectRun(ctx: CmdCtx, raw: string | undefined): Promise<void> {
  const h = await pickHarness(ctx, raw);
  const url = mcpUrl(ctx.cfg.apiUrl);
  const scope = scopeFor(ctx, h);
  const path = h.path(scope, homeOf(ctx.io.env), ctx.io.cwd);

  if (flag(ctx, "print")) {
    if (ctx.json) return emit(ctx, { agent: h.id, path, snippet: snippet(h, url) });
    ctx.io.out(`Add this to ${path}:`);
    ctx.io.out(snippet(h, url));
    ctx.io.out(h.signIn);
    return;
  }

  const installed = await detect(h, ctx.io.env);
  if (!installed && !flag(ctx, "force")) {
    if (ctx.json) return emit(ctx, { agent: h.id, installed: false, path, snippet: snippet(h, url) });
    ctx.io.out(`${h.label} isn't on this computer yet, so nothing was changed.`);
    ctx.io.out(`After you install it, run this again. Or add this to ${path} yourself:`);
    ctx.io.out(snippet(h, url));
    ctx.io.out(mut("To write the file anyway, add --force."));
    return;
  }

  const ready = await serverReady(ctx);
  if (!ready && !ctx.json) {
    ctx.io.err(`warning: ${ctx.cfg.apiUrl} did not answer as a Tallyline server. The file is still written; check the address with 'tallyline doctor'.`);
  }

  const dryRun = flag(ctx, "dry-run");
  if (!dryRun && ctx.io.prompter && !flag(ctx, "yes")) {
    const ok = await ctx.io.prompter.confirm({
      message: `Add tallyline to ${path}? Other entries stay as they are, and a backup is kept.`,
      initial: true,
    });
    if (!ok) {
      ctx.io.out("Nothing was changed.");
      return;
    }
  }

  const r = await connectAgent({ harness: h, scope, apiUrl: ctx.cfg.apiUrl, env: ctx.io.env, cwd: ctx.io.cwd, dryRun });
  const verified = dryRun || !r.changed ? undefined : await isConnected(h, r.path, url);
  if (!dryRun && r.changed && !verified) {
    throw new CliError(1, `wrote ${r.path} but could not read the entry back. Run 'tallyline agent undo ${h.id}'.`);
  }
  if (ctx.json) {
    return emit(ctx, {
      agent: h.id,
      path: r.path,
      server: url,
      serverReady: ready,
      dryRun,
      changed: r.changed,
      created: r.created,
      replaced: r.replaced,
      ...(r.backup ? { backup: r.backup } : {}),
    });
  }
  if (dryRun) {
    ctx.io.out(`Would write ${r.path}:`);
    ctx.io.out(r.text);
    return;
  }
  if (!r.changed) {
    ctx.io.out(`${h.label} already points at ${url}. Nothing to change.`);
  } else {
    ctx.io.out(`${r.replaced ? "Updated" : "Added"} tallyline in ${r.path}`);
    if (r.backup) ctx.io.out(mut(`Backup: ${r.backup}`));
  }
  ctx.io.out(`Next: ${h.signIn}`);
  ctx.io.out(mut("The agent gets read and write access. Reviews stay with people."));
  ctx.io.out(mut(`To take it back out: tallyline agent undo ${h.id}`));
}

async function undoRun(ctx: CmdCtx, raw: string | undefined): Promise<void> {
  if (raw === undefined) throw new CliError(2, `say which agent to undo: ${HARNESS_IDS.join(", ")}`);
  const h = await pickHarness(ctx, raw);
  const r = await undoAgent({ harness: h, env: ctx.io.env });
  if (ctx.json) return emit(ctx, { agent: h.id, undone: r !== undefined, ...(r ?? {}) });
  if (!r) {
    ctx.io.out(`No change from 'tallyline agent connect ${h.id}' to undo.`);
    return;
  }
  ctx.io.out(r.removedFile ? `Removed ${r.path} (this tool created it).` : `Put ${r.path} back the way it was for tallyline.`);
}

export const agentCmd: Command = {
  usage: USAGE,
  summary: "connect a coding agent (Claude Code, Codex, Cursor, opencode) to this server",
  options: {
    project: { type: "boolean" },
    "dry-run": { type: "boolean" },
    print: { type: "boolean" },
    force: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
  },
  needsApi: false,
  async run(ctx) {
    const [sub, name] = ctx.args;
    if (sub === undefined || sub === "list") return listRun(ctx);
    if (sub === "connect") return connectRun(ctx, name);
    if (sub === "undo") return undoRun(ctx, name);
    throw new CliError(2, `unknown 'agent' action '${sub}'. Usage: ${USAGE}`);
  },
};
