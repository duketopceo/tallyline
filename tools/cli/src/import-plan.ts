import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  PlanEvidence,
  PlanImportDiff,
  PlanImportRequest,
} from "@tallyline/types";
import { ApiError } from "./client.js";
import {
  fail,
  usage,
  type CmdCtx,
  type Command,
  type FlagValues,
} from "./commands.js";

const execFileP = promisify(execFile);

const MAX_PLAN_CHARS = 1_000_000; // the API rejects more
const FETCH_TIMEOUT_MS = 30_000;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const str = (flags: FlagValues, name: string): string | undefined => {
  const v = flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const last = v.at(-1);
    return typeof last === "string" ? last : undefined;
  }
  return undefined;
};

interface PlanSource {
  markdown: string;
  repo: string;
  path: string;
  sha: string;
  url?: string;
}

async function git(dir: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, ...args], {
      timeout: 10_000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function repoFromRemote(remote: string): string | undefined {
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(remote);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

// github blob/raw urls carry repo, ref and path; anything else needs flags
function parseGithubUrl(
  u: URL,
): { repo: string; ref: string; path: string; raw: string } | undefined {
  const parts = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "github.com" && parts[2] === "blob" && parts.length > 4) {
    const [owner, name, , ref, ...rest] = parts as [string, string, string, string, ...string[]];
    const path = rest.join("/");
    return {
      repo: `${owner}/${name}`,
      ref,
      path,
      raw: `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${path}`,
    };
  }
  if (u.hostname === "raw.githubusercontent.com" && parts.length > 3) {
    const [owner, name, ref, ...rest] = parts as [string, string, string, ...string[]];
    return { repo: `${owner}/${name}`, ref, path: rest.join("/"), raw: u.toString() };
  }
  return undefined;
}

async function loadSource(ctx: CmdCtx, arg: string): Promise<PlanSource> {
  const repoFlag = str(ctx.flags, "repo");
  const pathFlag = str(ctx.flags, "source-path");
  const shaFlag = str(ctx.flags, "sha");
  if (repoFlag !== undefined && !REPO_RE.test(repoFlag)) {
    throw usage("--repo must look like owner/repo");
  }
  if (shaFlag !== undefined && !SHA_RE.test(shaFlag)) {
    throw usage("--sha must be 7-40 hex characters");
  }

  let markdown: string;
  let repo = repoFlag;
  let path = pathFlag;
  let sha = shaFlag;

  if (/^https?:\/\//i.test(arg)) {
    // fetched here so the API never needs repo credentials
    const u = new URL(arg);
    if (u.protocol !== "https:") throw usage("plan urls must be https");
    const gh = parseGithubUrl(u);
    repo ??= gh?.repo;
    path ??= gh?.path;
    if (sha === undefined && gh && SHA_RE.test(gh.ref)) sha = gh.ref;
    let res: Response;
    try {
      res = await ctx.io.fetch(
        new Request(gh?.raw ?? u.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
      );
    } catch (err) {
      throw fail(
        `could not fetch ${arg}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw fail(`could not fetch ${arg}: HTTP ${res.status}`);
    markdown = await res.text();
  } else {
    const abs = isAbsolute(arg) ? arg : resolve(ctx.io.cwd, arg);
    try {
      markdown = await readFile(abs, "utf8");
    } catch {
      throw fail(`cannot read plan file ${abs}`);
    }
    if (repo === undefined || path === undefined || sha === undefined) {
      const real = await realpath(abs);
      const dir = dirname(real);
      const top = await git(dir, "rev-parse", "--show-toplevel");
      if (top) {
        if (repo === undefined) {
          const remote = await git(dir, "config", "--get", "remote.origin.url");
          repo = remote ? repoFromRemote(remote) : undefined;
        }
        path ??= relative(await realpath(top), real).split(sep).join("/");
        sha ??= (await git(dir, "rev-parse", "HEAD")) ?? undefined;
      }
    }
  }

  if (markdown.length > MAX_PLAN_CHARS) {
    throw usage("plan is over 1,000,000 characters");
  }
  const missing = [
    repo === undefined && "--repo",
    path === undefined && "--source-path",
    sha === undefined && "--sha",
  ].filter(Boolean);
  if (repo === undefined || path === undefined || sha === undefined) {
    throw usage(
      `could not work out the plan's source (${missing.join(", ")}) — ` +
        "pass the flags, or run inside a git checkout with a github origin",
    );
  }
  return {
    markdown,
    repo,
    path,
    sha,
    url: `https://github.com/${repo}/blob/${sha}/${path}`,
  };
}

async function readJsonFlag<T>(
  ctx: CmdCtx,
  name: string,
): Promise<T | undefined> {
  const file = str(ctx.flags, name);
  if (file === undefined) return undefined;
  const abs = isAbsolute(file) ? file : resolve(ctx.io.cwd, file);
  try {
    const parsed: unknown = JSON.parse(await readFile(abs, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as T;
  } catch (err) {
    throw usage(
      `--${name} ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function render(ctx: CmdCtx, diff: PlanImportDiff, scope: string, src: PlanSource): void {
  if (ctx.json) {
    ctx.io.out(JSON.stringify(diff));
    return;
  }
  const c = diff.counts;
  const out = ctx.io.out;
  out(`import-plan ${diff.mode}  ${scope}  ${src.repo}:${src.path}@${src.sha.slice(0, 7)}`);
  out(
    `${c.create} create · ${c.update} update · ${c.unchanged} unchanged · ` +
      `${c.ambiguous} ambiguous · ${c.invalid} invalid`,
  );
  for (const u of diff.units) {
    if (u.action === "unchanged") continue;
    const extra: string[] = [];
    if (u.issueKey) extra.push(u.issueKey);
    if (u.changes?.length) extra.push(`changes: ${u.changes.join(", ")}`);
    if (u.state) extra.push(u.state);
    if (u.reason) extra.push(u.reason);
    out(
      `  ${u.action.padEnd(9)}  ${u.scopedId}  ${u.title}` +
        (extra.length ? `  (${extra.join("; ")})` : ""),
    );
    for (const cand of u.candidates ?? []) {
      out(`             candidate ${cand.key} "${cand.title}" [${cand.reason}]`);
    }
  }
  if (diff.milestones.create.length) {
    out(`milestones to create: ${diff.milestones.create.join(", ")}`);
  }
  for (const w of diff.warnings) out(`warning: ${w}`);
  if (diff.applied) {
    out(
      `applied: ${diff.applied.created.length} created` +
        (diff.applied.created.length
          ? ` (${diff.applied.created.map((x) => x.key).join(", ")})`
          : "") +
        `, ${diff.applied.updated.length} updated`,
    );
  }
  out(`diffHash: ${diff.diffHash}`);
  if (diff.mode === "dry_run") {
    out("nothing was written. To apply this exact diff, re-run with:");
    out(`  --apply --diff-hash ${diff.diffHash}`);
  }
}

export const importPlanCmd: Command = {
  usage:
    "tallyline import-plan <path|https-url> --project <name|id> --scope <KP> " +
    "[--team K] [--repo o/r] [--source-path p] [--sha s] [--evidence f.json] " +
    "[--resolutions f.json] [--historical] [--apply --diff-hash <hash>]",
  summary:
    "import a ce-plan markdown file as issues. Dry run by default (prints the " +
    "diff and a diffHash, writes nothing); apply with the reviewed hash. " +
    "repo/path/sha come from the git checkout or a github url unless given.",
  options: {
    project: { type: "string" },
    scope: { type: "string" },
    team: { type: "string" },
    repo: { type: "string" },
    "source-path": { type: "string" },
    sha: { type: "string" },
    evidence: { type: "string" },
    resolutions: { type: "string" },
    historical: { type: "boolean" },
    apply: { type: "boolean" },
    "diff-hash": { type: "string" },
  },
  needsApi: true,
  async run(ctx) {
    const arg = ctx.args[0];
    if (arg === undefined) throw usage("missing plan path or url");
    const project = str(ctx.flags, "project");
    if (!project) throw usage("--project <name|id> is required");
    const scope = str(ctx.flags, "scope");
    if (!scope) {
      throw usage("--scope is required (1-8 chars of A-Z0-9, e.g. KP)");
    }
    const hash = str(ctx.flags, "diff-hash");
    const apply = ctx.flags.apply === true;
    if (hash !== undefined && !apply) {
      throw usage("--diff-hash only makes sense with --apply");
    }

    const src = await loadSource(ctx, arg);
    const evidence = await readJsonFlag<Record<string, PlanEvidence>>(ctx, "evidence");
    const resolutions = await readJsonFlag<Record<string, string>>(ctx, "resolutions");
    const team = str(ctx.flags, "team");
    const base: PlanImportRequest = {
      project,
      ...(team ? { teamKey: team } : {}),
      plan: {
        scope,
        source: { repo: src.repo, path: src.path, sha: src.sha, ...(src.url ? { url: src.url } : {}) },
        markdown: src.markdown,
      },
      ...(evidence ? { evidence } : {}),
      ...(resolutions ? { resolutions } : {}),
      ...(ctx.flags.historical === true ? { historical: true } : {}),
    };

    if (!apply || hash === undefined) {
      const dry = await ctx.client.importPlan({ ...base, mode: "dry_run" });
      render(ctx, dry, scope, src);
      if (apply) {
        // --apply alone still shows the diff first; the write needs the hash
        throw usage(
          "--apply needs --diff-hash <hash> from a reviewed dry run; nothing was written",
        );
      }
      return;
    }

    try {
      const done = await ctx.client.importPlan({ ...base, mode: "apply", diffHash: hash });
      render(ctx, done, scope, src);
    } catch (err) {
      const diff = err instanceof ApiError && err.code === "STALE_DIFF"
        ? (err.details as { diff?: PlanImportDiff } | undefined)?.diff
        : undefined;
      if (diff) render(ctx, diff, scope, src);
      throw err;
    }
  },
};
