import { chmod, stat } from "node:fs/promises";
import { ApiError, whoami } from "./client.js";
import { CliError } from "./cli-error.js";
import type { CmdCtx, Command } from "./commands.js";
import { globalConfigPath, resolveConfig } from "./config.js";
import { credentialsPath, realKind, type TokenStore } from "./secrets.js";
import { friendlyApiError } from "./ui/errors.js";
import { nextSteps, section, statusLine, type Level } from "./ui/render.js";
import { bold, dim } from "./pretty.js";

// `tallyline doctor`: every check answers in plain words and, when it can,
// says the one thing to do. Checks never throw; a broken check is a failed
// check. `--json` is the stable machine shape; `--fix` only tightens file
// permissions and always asks first.

export type Status = "ok" | "warn" | "fail";
export type Group = "server" | "connection" | "computer";

export interface Check {
  id: string;
  group: Group;
  status: Status;
  message: string;
  fix?: string;
  /** set when `--fix` can repair this on its own */
  fixId?: "chmod-private";
  path?: string;
}

const GROUP_TITLE: Record<Group, string> = {
  server: "Your server",
  connection: "Your sign-in",
  computer: "This computer",
};

const LEVEL: Record<Status, Level> = { ok: "ok", warn: "warn", fail: "fail" };

function tilde(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

async function loosePath(path: string): Promise<boolean | undefined> {
  try {
    return ((await stat(path)).mode & 0o077) !== 0;
  } catch {
    return undefined; // file doesn't exist
  }
}

export async function runChecks(ctx: CmdCtx, tokens: TokenStore | undefined): Promise<Check[]> {
  const { io } = ctx;
  const checks: Check[] = [];
  const { config } = await resolveConfig({
    env: io.env,
    cwd: io.cwd,
    ...(tokens ? { tokens } : {}),
  });
  const host = (() => {
    try {
      return new URL(config.apiUrl).host;
    } catch {
      return config.apiUrl;
    }
  })();

  // ── your server
  try {
    const res = await io.fetch(
      new Request(`${config.apiUrl.replace(/\/+$/, "")}/health`, {
        signal: AbortSignal.timeout(8000),
      }),
    );
    const body = (await res.json().catch(() => ({}))) as { status?: string; postgres?: boolean };
    if (res.ok && body.status === "ok") {
      checks.push({ id: "server-reachable", group: "server", status: "ok", message: `${host} is up` });
    } else if (res.status === 503 || body.postgres === false) {
      checks.push({
        id: "server-reachable",
        group: "server",
        status: "fail",
        message: `${host} answered, but its database isn't responding`,
        fix: "Check the database container or service, then run tallyline doctor again.",
      });
    } else {
      checks.push({
        id: "server-reachable",
        group: "server",
        status: "fail",
        message: `${host} answered, but not like a Tallyline server (HTTP ${res.status})`,
        fix: "Check the address with tallyline config get server.",
      });
    }
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    checks.push({
      id: "server-reachable",
      group: "server",
      status: "fail",
      message: `can't reach ${host}`,
      fix: /certificate|tls|ssl/i.test(why)
        ? "The server's HTTPS certificate isn't valid. Check its address, or ask whoever runs it."
        : "Check your internet connection and the address (tallyline config get server).",
    });
  }

  // ── your sign-in
  if (!config.token) {
    checks.push({
      id: "signed-in",
      group: "connection",
      status: "fail",
      message: "you aren't signed in",
      fix: "tallyline connect",
    });
  } else {
    const source = io.env.TALLYLINE_TOKEN ? "TALLYLINE_TOKEN" : "your saved sign-in";
    try {
      const who = await whoami(config.apiUrl, config.token, io.fetch);
      checks.push({
        id: "signed-in",
        group: "connection",
        status: "ok",
        message: `signed in as ${who.name}`,
      });
      if (source === "TALLYLINE_TOKEN") {
        checks.push({
          id: "token-source",
          group: "connection",
          status: "warn",
          message: "using a token from the TALLYLINE_TOKEN environment variable",
          fix: "tallyline connect   saves a sign-in to your keychain instead",
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 0) {
        checks.push({
          id: "signed-in",
          group: "connection",
          status: "warn",
          message: "couldn't check your sign-in because the server isn't reachable",
        });
      } else {
        const f = err instanceof ApiError ? friendlyApiError(err.status, err.code, err.message) : undefined;
        checks.push({
          id: "signed-in",
          group: "connection",
          status: "fail",
          message: f?.title.toLowerCase() ?? "your sign-in didn't work",
          fix: f?.fix ?? "tallyline connect",
        });
      }
    }
  }
  checks.push(
    config.workspace
      ? { id: "workspace", group: "connection", status: "ok", message: `workspace is ${config.workspace}` }
      : {
          id: "workspace",
          group: "connection",
          status: "warn",
          message: "no workspace chosen yet",
          fix: "tallyline config set workspace <slug>",
        },
  );

  // ── this computer
  const major = Number((io.env.TALLYLINE_DOCTOR_NODE ?? process.versions.node).split(".")[0]);
  checks.push(
    major >= 20
      ? { id: "node", group: "computer", status: "ok", message: `Node ${io.env.TALLYLINE_DOCTOR_NODE ?? process.versions.node}` }
      : {
          id: "node",
          group: "computer",
          status: "fail",
          message: `Node ${io.env.TALLYLINE_DOCTOR_NODE ?? process.versions.node} is too old`,
          fix: "Install Node 20 or newer from nodejs.org.",
        },
  );

  const kind = tokens ? await realKind(tokens) : undefined;
  if (kind === "file") {
    checks.push({
      id: "keychain",
      group: "computer",
      status: "warn",
      message: "sign-in is kept in a private file, not your system keychain",
      fix:
        process.platform === "linux"
          ? "Install libsecret-tools (secret-tool) to use your keychain."
          : "This is fine for a personal computer; the file is readable only by you.",
    });
  } else if (kind) {
    checks.push({
      id: "keychain",
      group: "computer",
      status: "ok",
      message: kind === "macos-keychain" ? "sign-in is kept in your Mac keychain" : "sign-in is kept in your system keychain",
    });
  }

  for (const [id, path] of [
    ["config-private", globalConfigPath(io.env)],
    ["credentials-private", credentialsPath(io.env)],
  ] as const) {
    const loose = await loosePath(path);
    if (loose === undefined) continue;
    checks.push(
      loose
        ? {
            id,
            group: "computer",
            status: "warn",
            message: `${tilde(path, io.env.HOME)} can be read by other people on this computer`,
            fix: `chmod 600 ${tilde(path, io.env.HOME)}   (or run tallyline doctor --fix)`,
            fixId: "chmod-private",
            path,
          }
        : { id, group: "computer", status: "ok", message: `${tilde(path, io.env.HOME)} is private` },
    );
  }
  return checks;
}

function summarize(checks: Check[]): { ok: boolean; fails: number; warns: number } {
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  return { ok: fails === 0, fails, warns };
}

function renderChecks(checks: Check[]): string {
  const blocks: string[] = [];
  for (const g of ["server", "connection", "computer"] as Group[]) {
    const mine = checks.filter((c) => c.group === g);
    if (!mine.length) continue;
    const lines: string[] = [];
    for (const c of mine) {
      lines.push(statusLine(LEVEL[c.status], c.message));
      if (c.fix && c.status !== "ok") lines.push(`  ${dim(c.fix)}`);
    }
    blocks.push(section(GROUP_TITLE[g], lines));
  }
  return blocks.join("\n\n");
}

export const doctorCmd: Command = {
  usage: "tallyline doctor [--fix] [--yes] [--json]",
  summary: "check that your server, sign-in and this computer are healthy, and say how to fix what isn't",
  options: {
    fix: { type: "boolean" },
    yes: { type: "boolean", short: "y" },
  },
  needsApi: false,
  run: async (ctx) => {
    const tokens = ctx.io.tokens;
    let checks = await runChecks(ctx, tokens);

    const fixable = checks.filter((c) => c.fixId === "chmod-private" && c.path);
    const fixed: string[] = [];
    if (ctx.flags.fix === true && fixable.length) {
      let go = ctx.flags.yes === true;
      if (!go && ctx.io.isTTY === true && ctx.io.prompter) {
        go = await ctx.io.prompter.confirm({
          message: `Make ${fixable.length === 1 ? "this file" : "these files"} private to you (chmod 600)?`,
          initial: true,
        });
      }
      if (go) {
        for (const c of fixable) {
          await chmod(c.path as string, 0o600);
          fixed.push(c.path as string);
        }
        checks = await runChecks(ctx, tokens);
      } else if (ctx.io.isTTY !== true) {
        throw new CliError(2, "--fix changes files, so pass --yes to confirm (or run it in a terminal)");
      }
    }

    const sum = summarize(checks);
    if (ctx.json) {
      ctx.io.out(JSON.stringify({ ok: sum.ok, fixed, checks: checks.map(({ path: _p, fixId: _f, ...c }) => c) }));
    } else if (ctx.io.isTTY === true) {
      ctx.io.out(renderChecks(checks));
      ctx.io.out("");
      if (fixed.length) ctx.io.out(`${statusLine("ok", `Made ${fixed.length} file${fixed.length === 1 ? "" : "s"} private`)}\n`);
      ctx.io.out(
        sum.ok
          ? sum.warns
            ? `${bold("All working.")} ${dim(`${sum.warns} thing${sum.warns === 1 ? "" : "s"} you may want to look at.`)}`
            : bold("Everything looks good.")
          : bold(`${sum.fails} thing${sum.fails === 1 ? " needs" : "s need"} attention.`),
      );
      const first = checks.find((c) => c.status === "fail" && c.fix?.startsWith("tallyline "));
      if (first?.fix) ctx.io.out("\n" + nextSteps([[first.fix.split("   ")[0] as string, "fix the first problem"]]));
    } else {
      for (const c of checks) ctx.io.out(`${c.status} ${c.group}/${c.id}: ${c.message}`);
      for (const p of fixed) ctx.io.out(`fixed ${p}`);
    }
    if (!sum.ok) throw new CliError(1, "");
  },
};
