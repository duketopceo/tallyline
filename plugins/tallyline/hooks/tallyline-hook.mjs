#!/usr/bin/env node
// Tallyline session hooks: claim the ticket at session start, report progress
// at stop. MIT licensed, node >= 20 standard library only.
//
// Contract: this script NEVER blocks the agent. Every failure (no ticket id,
// no token, unreachable API, HTTP error, bad stdin) ends in exit code 0.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KEY_RE = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)-(\d+)(?![0-9])/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const DEFAULT_API_URL = "http://localhost:4000";
const HTTP_TIMEOUT_MS = 5000;

/** Ticket id from TALLYLINE_ISSUE, else from the branch name. Null when none. */
export function resolveIssueKey(env, branch) {
  const fromEnv = (env.TALLYLINE_ISSUE ?? "").trim().toUpperCase();
  if (fromEnv) return ISSUE_KEY_PATTERN.test(fromEnv) ? fromEnv : null;
  const m = KEY_RE.exec(branch ?? "");
  if (!m) return null;
  const key = `${m[1]}-${m[2]}`.toUpperCase();
  return ISSUE_KEY_PATTERN.test(key) ? key : null;
}

function readJson(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Same precedence as the CLI: user file < project files < env. */
export function loadConfig(env, cwd) {
  const home = env.HOME ?? homedir();
  const merged = {};
  for (const p of [
    join(home, ".config", "tallyline", "config.json"),
    join(cwd, ".tallyline", "config.json"),
    join(cwd, ".tallyline.json"),
  ]) {
    const f = readJson(p);
    for (const k of ["apiUrl", "token", "workspace"]) {
      if (typeof f[k] === "string" && f[k]) merged[k] = f[k];
    }
  }
  if (env.TALLYLINE_API_URL) merged.apiUrl = env.TALLYLINE_API_URL;
  if (env.TALLYLINE_TOKEN) merged.token = env.TALLYLINE_TOKEN;
  if (env.TALLYLINE_WORKSPACE) merged.workspace = env.TALLYLINE_WORKSPACE;
  const token = merged.token?.trim();
  const workspace = merged.workspace?.trim();
  if (!token || !workspace) return null;
  return {
    apiUrl: (merged.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, ""),
    token,
    workspace,
  };
}

function makeApi(cfg, fetchImpl) {
  const ws = `${cfg.apiUrl}/v1/workspaces/${encodeURIComponent(cfg.workspace)}`;
  async function call(method, url, body) {
    const res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  return {
    whoami: () => call("GET", `${cfg.apiUrl}/v1/whoami`),
    getIssue: (key) => call("GET", `${ws}/issues/${encodeURIComponent(key)}`),
    patchIssue: (key, body) =>
      call("PATCH", `${ws}/issues/${encodeURIComponent(key)}`, body),
    comment: (key, body) =>
      call("POST", `${ws}/issues/${encodeURIComponent(key)}/comments`, { body }),
  };
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 4000 }, (err, stdout) =>
      resolve(err ? "" : String(stdout).trim()),
    );
  });
}

async function gitInfo(cwd, exec, withPr) {
  const [branch, sha, subject, pr] = await Promise.all([
    exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    exec("git", ["rev-parse", "HEAD"], cwd),
    exec("git", ["log", "-1", "--format=%s"], cwd),
    withPr ? exec("gh", ["pr", "view", "--json", "url", "-q", ".url"], cwd) : "",
  ]);
  return { branch, sha, subject, prUrl: /^https?:\/\//.test(pr) ? pr : "" };
}

function stateFile(stateDir, sessionId, key) {
  const id = createHash("sha256")
    .update(`${sessionId}:${key}`)
    .digest("hex")
    .slice(0, 16);
  return join(stateDir, `tallyline-hook-${id}.json`);
}

function writeState(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  } catch {
    // state is best-effort; losing it only risks one duplicate comment
  }
}

/**
 * Session start: record the starting commit, then claim the ticket. Returns
 * a one-line announcement for the agent's context, or "" when nothing to say.
 */
export async function sessionStart(deps) {
  const { env, cwd, input, stateDir } = deps;
  const git = await gitInfo(cwd, deps.exec ?? run, false);
  const key = resolveIssueKey(env, git.branch);
  if (!key) return "";
  writeState(stateFile(stateDir, input.session_id ?? "", key), {
    startSha: git.sha,
  });
  const cfg = loadConfig(env, cwd);
  if (!cfg) return "";
  const api = makeApi(cfg, deps.fetchImpl ?? fetch);
  try {
    const [issue, me] = await Promise.all([api.getIssue(key), api.whoami()]);
    const owner = issue.assigneeId ?? null;
    if (owner && owner !== me.id) {
      return `Tallyline: working ${key} "${issue.title}" (assigned to someone else, not claimed).`;
    }
    const hops = { backlog: ["todo", "in_progress"], todo: ["in_progress"] };
    const path = hops[issue.state];
    if (path === undefined) {
      return `Tallyline: working ${key} "${issue.title}" (state ${issue.state}).`;
    }
    const assignee = { assigneeType: me.type, assigneeId: me.id };
    await api.patchIssue(key, { ...assignee, state: path[0] });
    for (const state of path.slice(1)) await api.patchIssue(key, { state });
    return `Tallyline: claimed ${key} "${issue.title}" (now in_progress).`;
  } catch {
    return "";
  }
}

/**
 * Stop fires after every agent turn, so it only reports when something new
 * exists: HEAD moved since session start, or since the last report, or a PR
 * appeared. It comments with the commit and PR link, and moves
 * in_progress -> in_review once a PR exists. Returns a status string (tests).
 */
export async function stop(deps) {
  const { env, cwd, input, stateDir } = deps;
  const git = await gitInfo(cwd, deps.exec ?? run, true);
  const key = resolveIssueKey(env, git.branch);
  if (!key) return "noop:no-ticket";
  if (!git.sha) return "noop:no-commit";
  const file = stateFile(stateDir, input.session_id ?? "", key);
  const state = readJson(file);
  if (state.lastSha === git.sha && (state.lastPr ?? "") === git.prUrl) {
    return "noop:already-reported";
  }
  if (state.startSha === git.sha && !git.prUrl && !state.lastSha) {
    return "noop:no-new-commit";
  }
  const cfg = loadConfig(env, cwd);
  if (!cfg) return "noop:no-config";
  const api = makeApi(cfg, deps.fetchImpl ?? fetch);
  try {
    const lines = [`Session update: commit ${git.sha.slice(0, 8)} ${git.subject}`.trim()];
    if (git.prUrl) lines.push(`Pull request: ${git.prUrl}`);
    await api.comment(key, lines.join("\n"));
    let moved = false;
    if (git.prUrl) {
      const issue = await api.getIssue(key);
      if (issue.state === "in_progress") {
        await api.patchIssue(key, { state: "in_review" });
        moved = true;
      }
    }
    writeState(file, { ...state, lastSha: git.sha, lastPr: git.prUrl });
    return moved ? "updated:in_review" : "updated:comment";
  } catch {
    return "noop:api-error";
  }
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  try {
    for await (const c of process.stdin) chunks.push(c);
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function main(argv, env = process.env) {
  try {
    const input = await readStdin();
    const deps = {
      env,
      cwd: typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(),
      input,
      stateDir: join(tmpdir(), "tallyline-hooks"),
    };
    if (argv[0] === "session-start") {
      const line = await sessionStart(deps);
      if (line) process.stdout.write(`${line}\n`);
    } else if (argv[0] === "stop") {
      await stop(deps);
    }
  } catch {
    // fail soft, always
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(() => process.exit(0));
}
