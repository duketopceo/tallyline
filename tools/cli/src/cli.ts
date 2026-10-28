import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { ApiClient, ApiError } from "./client.js";
import { commands, CliError, type CliIo, type CmdCtx } from "./commands.js";
import { resolveConfig } from "./config.js";
import { banner, mut, setColor, versionTag } from "./pretty.js";
import {
  friendlyApiError,
  friendlyMissingConfig,
  friendlyUsage,
  type Friendly,
} from "./ui/errors.js";
import { prettyHelp } from "./ui/help.js";
import { hostOf, loadHome, renderHome } from "./ui/home.js";
import { errorBlock } from "./ui/render.js";

export const VERSION = "2.0.0";

const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  json: { type: "boolean" },
  format: { type: "string" },
  workspace: { type: "string", short: "w" },
  "api-url": { type: "string" },
  token: { type: "string" },
  help: { type: "boolean", short: "h" },
  "no-color": { type: "boolean" },
};

export const HELP = `tallyline — work the board from a shell (alias: tly)

usage: tallyline <command> [args] [flags]

work loop:
  ready       issues ready to work — todo, unassigned-or-mine, by priority
  next        your in_progress issue, else the top of ready
  claim       claim <KEY> [--as name|uuid] [--type agent|human]
  start       start <KEY>   — move to in_progress
  done        done <KEY>    — move to done (steps through in_review)
  state       state <KEY> <state> — arbitrary legal transition

issues:
  create      create --title T [--team K] [--state backlog|triage]
              [--priority p] [--description d] [--assignee a] [--parent KEY]
  list        list [--state s] [--assignee me|none|name|uuid] [--search q]
  search      search <query>
  show        show <KEY> — detail + comments
  comment     comment <KEY> [body] [--body b]  (or stdin)
  triage      triage <KEY> accept|decline
  teams       teams [list] | teams create --key K --name N [--rollover r]

plans:
  import-plan import-plan <path|https-url> --project P --scope KP
              dry run by default: prints the diff + a diffHash, writes nothing
              then: --apply --diff-hash <hash>  (needs write scope)
              [--team K] [--repo o/r --source-path p --sha s] [--resolutions f]
              [--evidence f --historical]  (human owner/admin token only)

feed:
  events      events [--limit N] [--after id] [--follow]

setup:
  init        init --workspace <slug> [--api-url u] [--agent-id id]
              writes ./.tallyline/config.json + agent.md

global flags:
  --json / --format json   machine-readable output (agent chaining)
  --format text            human output (default)
  -w, --workspace <slug>   workspace override
  --api-url <url>          API base (default http://localhost:4000)
  --token <tok>            bearer token override
  -h, --help               command help
  --version                print version

environment:
  TALLYLINE_API_URL    api base url
  TALLYLINE_TOKEN      tly_agt_* agent key, tly_pat_* PAT, or access JWT
  TALLYLINE_WORKSPACE  workspace slug
  TALLYLINE_AGENT_ID   your agent uuid/name — claim/next/ready "mine"
  TALLYLINE_USER_ID    your user uuid — human identity
  config files        ~/.config/tallyline/config.json, ./.tallyline/config.json,
                      ./.tallyline.json (env and flags override)

exit codes:
  0 ok · 1 error · 2 usage/config · 3 unauthorized/forbidden ·
  4 not found · 5 conflict — API errors print "CODE: message" on stderr`;

function commandHelp(name: string): string {
  const cmd = commands[name];
  if (!cmd) return HELP;
  return `usage: ${cmd.usage}\n\n${cmd.summary}`;
}

// HTTP status -> exit code so scripts can distinguish failure classes.
function apiExitCode(status: number): number {
  if (status === 400) return 2;
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status === 409) return 5;
  return 1;
}

function wantsColor(argv: string[], io: CliIo): boolean {
  if (argv.includes("--no-color")) return false;
  if (io.env.FORCE_COLOR) return true;
  if (io.env.NO_COLOR !== undefined) return false;
  return io.isTTY === true;
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  setColor(wantsColor(argv, io));
  // Decoration and friendly language are for people at a terminal only. Pipes,
  // CI and --json keep the stable plain output (golden.test.ts pins it).
  const interactive =
    io.isTTY === true && !argv.includes("--json") && !argv.includes("--format");
  const name = argv[0];
  try {
    if (name === undefined) {
      if (interactive) return await runHome(io);
      io.err(`${banner(VERSION)}\n\n${HELP}`);
      return 2;
    }
    if (name === "help" || name === "--help" || name === "-h") {
      if (argv[1] && argv[1] !== "all") {
        io.out(commandHelp(argv[1]));
      } else if (interactive && argv[1] !== "all") {
        io.out(prettyHelp(VERSION));
      } else {
        io.out(`${banner(VERSION)}\n\n${HELP}`);
      }
      return 0;
    }
    if (name === "--version") {
      io.out(versionTag(VERSION));
      return 0;
    }
    const cmd = commands[name];
    if (!cmd) {
      io.err(`unknown command '${name}' — ${mut("run 'tallyline help'")}`);
      return 2;
    }

    let flags: Record<
      string,
      string | boolean | (string | boolean)[] | undefined
    >;
    let positionals: string[];
    try {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: { ...GLOBAL_OPTIONS, ...cmd.options },
        allowPositionals: true,
        strict: true,
      });
      flags = parsed.values;
      positionals = parsed.positionals;
    } catch (err) {
      // parseArgs raises TypeError (ERR_PARSE_ARGS_*) — usage, not internal
      const msg = err instanceof Error ? err.message : String(err);
      throw new CliError(2, msg);
    }
    if (flags.help === true) {
      io.out(commandHelp(name));
      return 0;
    }
    const format =
      typeof flags.format === "string" ? flags.format : undefined;
    if (format !== undefined && format !== "json" && format !== "text") {
      throw new CliError(2, "--format must be 'json' or 'text'");
    }
    const json = flags.json === true || format === "json";

    const { config } = await resolveConfig({
      env: io.env,
      cwd: io.cwd,
      flags: {
        ...(typeof flags["api-url"] === "string"
          ? { apiUrl: flags["api-url"] }
          : {}),
        ...(typeof flags.token === "string" ? { token: flags.token } : {}),
        ...(typeof flags.workspace === "string"
          ? { workspace: flags.workspace }
          : {}),
      },
    });

    let client: ApiClient | undefined;
    if (cmd.needsApi) {
      if (!config.workspace) {
        if (interactive) {
          io.err(errorBlock(friendlyMissingConfig("workspace")));
          return 2;
        }
        throw new CliError(
          2,
          "no workspace configured — set TALLYLINE_WORKSPACE or run " +
            "`tallyline init --workspace <slug>`",
        );
      }
      if (!config.token) {
        if (interactive) {
          io.err(errorBlock(friendlyMissingConfig("token")));
          return 2;
        }
        throw new CliError(
          2,
          "no token configured — set TALLYLINE_TOKEN (tly_agt_* agent key, " +
            "tly_pat_* PAT, or access JWT)",
        );
      }
      client = new ApiClient({
        apiUrl: config.apiUrl,
        token: config.token,
        workspace: config.workspace,
        fetch: io.fetch,
      });
    }

    const ctx: CmdCtx = {
      io,
      cfg: config,
      client: client as ApiClient,
      json,
      flags,
      args: positionals,
    };
    await cmd.run(ctx);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      if (interactive) {
        io.err(errorBlock(friendlyApiError(err.status, err.code, err.message)));
      } else {
        io.err(`${err.code}: ${err.message}`);
      }
      return apiExitCode(err.status);
    }
    if (err instanceof CliError) {
      if (interactive) {
        const f: Friendly =
          err.exitCode === 2
            ? friendlyUsage(err.message, name)
            : { title: err.message, fix: "tallyline doctor", ref: "TLY-ERROR" };
        io.err(errorBlock(f));
        return err.exitCode;
      }
      io.err(err.message);
      if (name !== undefined && err.exitCode === 2) {
        io.err(`see 'tallyline ${name} --help'`);
      }
      return err.exitCode;
    }
    const msg = err instanceof Error ? err.message : String(err);
    io.err(`INTERNAL: ${msg}`);
    return 1;
  }
}

// `tallyline` with no arguments on a terminal: where things stand, and what to
// do next. Never throws; a server that is slow or away just shows "not connected".
async function runHome(io: CliIo): Promise<number> {
  const { config } = await resolveConfig({ env: io.env, cwd: io.cwd });
  const base = {
    version: VERSION,
    server: config.apiUrl,
    workspace: config.workspace ?? "",
  };
  const hour = new Date().getHours();
  if (!config.token || !config.workspace) {
    io.out(renderHome({ ...base, connected: false, inReview: 0, inTriage: 0, working: [] }, hour));
    return 0;
  }
  const client = new ApiClient({
    apiUrl: config.apiUrl,
    token: config.token,
    workspace: config.workspace,
    fetch: io.fetch,
  });
  const names = new Map<string, string>();
  try {
    for (const a of (await client.listAgents()).agents) names.set(a.id, a.name);
  } catch {
    // names are decoration; carry on without them
  }
  try {
    const data = await loadHome(client, base, (id) =>
      id ? (names.get(id) ?? "someone") : "unassigned",
    );
    io.out(renderHome(data, hour));
    return 0;
  } catch {
    io.out(renderHome({ ...base, connected: false, inReview: 0, inTriage: 0, working: [] }, hour));
    io.err(`Couldn't reach ${hostOf(config.apiUrl)} just now. Run tallyline doctor to check.`);
    return 0;
  }
}
