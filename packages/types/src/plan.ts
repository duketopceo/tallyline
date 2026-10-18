// Pure parser for ce-plan markdown (the unified-plan shape and the legacy
// `### U<N>.` shape). No I/O: the API's plan-import service feeds it the text
// and turns the result into issues. Also holds the request/response shapes of
// the import so the CLI and MCP server share them.

import type { IssueState } from "./index.js";

export interface GithubIssueRef {
  repo: string;
  number: number;
}

export interface PlanUnit {
  /** bare id as written in the plan, e.g. "U12" */
  id: string;
  title: string;
  goal: string | null;
  verification: string | null;
  files: string[];
  /** unit ids named by the dependency line or overview table, numerically sorted */
  dependencies: string[];
  githubIssues: GithubIssueRef[];
  /** name of the phase the unit sits under, when the plan has phases */
  phase: string | null;
  /** 1-based line of the unit heading */
  line: number;
}

export interface PlanPhase {
  name: string;
  unitIds: string[];
}

export interface LukeAction {
  number: number;
  text: string;
  slice: boolean;
  group: string | null;
}

export type PlanProblemCode = "MISSING_TITLE" | "DUPLICATE_ID";

export interface PlanProblem {
  unitId: string;
  code: PlanProblemCode;
  message: string;
  line: number;
}

export interface ParsedPlan {
  title: string | null;
  units: PlanUnit[];
  phases: PlanPhase[];
  lukeActions: LukeAction[];
  problems: PlanProblem[];
}

const LABELS = new Set([
  "goal",
  "requirements",
  "dependencies",
  "files",
  "approach",
  "test scenarios",
  "test expectation",
  "verification",
]);

// no trailing `\s*#*\s*$` patterns: they backtrack quadratically on a long
// run of spaces. Match loosely, then trim in code.
const UNIT_HEADING = /^(#{3,4})\s+U(\d+)\b[.:]?(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const MAX_LINE = 2_000;
const MAX_LINES = 100_000;

function cleanHeading(t: string): string {
  let out = t.trim();
  // drop an optional closing run of hashes ("## Title ##")
  const m = /\s#+$/.exec(out.length < 200 ? out : out.slice(-200));
  if (m && out.length < 200) out = out.slice(0, out.length - m[0].length).trim();
  return out;
}
const LABEL_LINE = /^\s*(?:[-*+]\s+)?\*\*([^*\n]+?)\*\*:?\s*(.*)$/;
const PHASE_HEADING = /^Phase\s+(?:[A-Z]|\d+[a-z]?)(?![\w])/;

interface Line {
  text: string;
  n: number;
  fenced: boolean;
}

function scan(markdown: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  markdown.split("\n", MAX_LINES).forEach((raw, i) => {
    const text = (raw.endsWith("\r") ? raw.slice(0, -1) : raw).slice(0, MAX_LINE);
    const m = /^\s*(```+|~~~+)/.exec(text);
    if (m) {
      if (fence === null) fence = m[1]![0]!;
      else if (m[1]![0] === fence) fence = null;
      out.push({ text, n: i + 1, fenced: true });
      return;
    }
    out.push({ text, n: i + 1, fenced: fence !== null });
  });
  return out;
}

function expandIds(text: string): string[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/\bU(\d+)(?:\s*[–—-]\s*U(\d+))?/g)) {
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b >= a && b - a <= 200) for (let k = a; k <= b; k++) ids.add(k);
    else ids.add(a);
  }
  return [...ids].sort((x, y) => x - y).map((n) => `U${n}`);
}

function tableCells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function parseGithubRefs(text: string): GithubIssueRef[] {
  const seen = new Set<string>();
  const out: GithubIssueRef[] = [];
  const add = (repo: string, num: string) => {
    const k = `${repo}#${num}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ repo, number: Number(num) });
    }
  };
  const re =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|(?<![\w/.:-])([\w.-]+\/[\w.-]+)#(\d+)/g;
  for (const m of text.matchAll(re)) {
    if (m[1]) add(m[1], m[2]!);
    else add(m[3]!, m[4]!);
  }
  return out;
}

interface Block {
  labels: Map<string, string>;
  firstParagraph: string | null;
  text: string;
}

function readBlock(lines: Line[]): Block {
  const labels = new Map<string, string>();
  let current: string | null = null;
  const buf: string[] = [];
  const flush = () => {
    if (current !== null && !labels.has(current)) labels.set(current, buf.join("\n").trim());
    buf.length = 0;
  };
  for (const l of lines) {
    const m = l.fenced ? null : LABEL_LINE.exec(l.text);
    const name = m ? m[1]!.trim().replace(/:$/, "").toLowerCase() : null;
    if (m && name && LABELS.has(name)) {
      flush();
      current = name;
      buf.push(m[2]!);
    } else if (current !== null) {
      buf.push(l.text);
    }
  }
  flush();

  let firstParagraph: string | null = null;
  const para: string[] = [];
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) {
      if (para.length) break;
      continue;
    }
    if (l.fenced || LABEL_LINE.test(l.text) || /^(?:[-*+]|\d+\.)\s/.test(t) || t.startsWith("|")) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  if (para.length) firstParagraph = para.join(" ");
  return { labels, firstParagraph, text: lines.map((l) => l.text).join("\n") };
}

function filesFrom(content: string): string[] {
  const out: string[] = [];
  for (const raw of content.split("\n")) {
    const spans = [...raw.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    if (!spans.length) continue;
    if (/^\s*[-*+]\s/.test(raw)) out.push(spans[0]!);
    else out.push(...spans);
  }
  return [...new Set(out)];
}

export function parsePlan(markdown: string): ParsedPlan {
  const lines = scan(markdown);
  let title: string | null = null;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (fm) {
    const t = /^title:\s*(.+?)\s*$/m.exec(fm[1]!);
    if (t) title = t[1]!.replace(/^["']|["']$/g, "");
  }

  interface Head {
    idx: number;
    level: number;
    text: string;
  }
  const heads: Head[] = [];
  lines.forEach((l, idx) => {
    if (l.fenced) return;
    const m = HEADING.exec(l.text);
    if (m) heads.push({ idx, level: m[1]!.length, text: cleanHeading(m[2]!) });
  });
  if (title === null) {
    const h1 = heads.find((h) => h.level === 1);
    if (h1) title = h1.text;
  }

  // overview table: unit -> dependency ids (fallback when a unit has no label)
  const tableDeps = new Map<string, string[]>();
  // phase table: Phase | ... | Units
  const tablePhases: PlanPhase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.fenced) continue;
    const head = tableCells(l.text);
    if (!head) continue;
    const lc = head.map((c) => c.toLowerCase());
    const depCol = lc.findIndex((c) => c === "depends on");
    const idCol = lc.findIndex((c) => c === "u-id" || c === "unit");
    const phaseCol = lc.findIndex((c) => c === "phase");
    const unitsCol = lc.findIndex((c) => c === "units" || c === "unit ids");
    const isOverview = depCol >= 0 && idCol >= 0;
    const isPhases = phaseCol >= 0 && unitsCol >= 0;
    if (!isOverview && !isPhases) continue;
    let lastRow = i;
    for (let j = i + 1; j < lines.length; j++) {
      const row = tableCells(lines[j]!.text);
      if (!row) break;
      lastRow = j;
      if (/^:?-{2,}:?$/.test(row[0] ?? "")) continue;
      if (isOverview) {
        const id = /^U\d+$/.exec(row[idCol] ?? "")?.[0];
        if (id) tableDeps.set(id, expandIds(row[depCol] ?? ""));
      } else if (row[phaseCol]) {
        tablePhases.push({ name: row[phaseCol]!, unitIds: expandIds(row[unitsCol] ?? "") });
      }
    }
    i = Math.max(i, lastRow);
  }

  const units: PlanUnit[] = [];
  const problems: PlanProblem[] = [];
  const headingPhases = new Map<string, string[]>();
  const seen = new Set<string>();
  let activePhase: { name: string; level: number } | null = null;

  for (let h = 0; h < heads.length; h++) {
    const head = heads[h]!;
    if (activePhase && head.level <= activePhase.level) activePhase = null;
    if (PHASE_HEADING.test(head.text)) {
      activePhase = { name: head.text, level: head.level };
      if (!headingPhases.has(head.text)) headingPhases.set(head.text, []);
      continue;
    }
    const um = UNIT_HEADING.exec(lines[head.idx]!.text);
    if (!um) continue;
    const id = `U${Number(um[2])}`;
    const unitTitle = cleanHeading(um[3]!);
    const line = lines[head.idx]!.n;
    if (!unitTitle) {
      problems.push({ unitId: id, code: "MISSING_TITLE", message: `${id} has no title`, line });
      continue;
    }
    if (seen.has(id)) {
      problems.push({
        unitId: id,
        code: "DUPLICATE_ID",
        message: `${id} appears more than once; only the first is used`,
        line,
      });
      continue;
    }
    seen.add(id);

    let end = lines.length;
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k]!.level <= head.level) {
        end = heads[k]!.idx;
        break;
      }
    }
    const block = readBlock(lines.slice(head.idx + 1, end));
    const goal = block.labels.get("goal") || block.firstParagraph;
    const depText = block.labels.get("dependencies");
    const dependencies = (
      depText !== undefined ? expandIds(depText) : (tableDeps.get(id) ?? [])
    ).filter((d) => d !== id);

    units.push({
      id,
      title: unitTitle,
      goal: goal ? goal.replace(/\s+/g, " ").trim() : null,
      verification: block.labels.get("verification") || null,
      files: filesFrom(block.labels.get("files") ?? ""),
      dependencies,
      githubIssues: parseGithubRefs(block.text),
      phase: activePhase?.name ?? null,
      line,
    });
    if (activePhase) headingPhases.get(activePhase.name)!.push(id);
  }

  const phases: PlanPhase[] = [
    ...[...headingPhases].map(([name, unitIds]) => ({ name, unitIds })),
    ...tablePhases,
  ];
  for (const p of tablePhases) {
    for (const u of units) if (u.phase === null && p.unitIds.includes(u.id)) u.phase = p.name;
  }

  return { title, units, phases, lukeActions: parseLukeActions(lines, heads), problems };
}

function parseLukeActions(
  lines: Line[],
  heads: { idx: number; level: number; text: string }[],
): LukeAction[] {
  const out: LukeAction[] = [];
  for (let h = 0; h < heads.length; h++) {
    const head = heads[h]!;
    if (!/\bLuke[ -]actions?\b/i.test(head.text)) continue;
    let end = lines.length;
    for (let k = h + 1; k < heads.length; k++) {
      if (heads[k]!.level <= head.level) {
        end = heads[k]!.idx;
        break;
      }
    }
    let group: string | null = null;
    let cur: LukeAction | null = null;
    for (const l of lines.slice(head.idx + 1, end)) {
      if (l.fenced) continue;
      const g = /^\*\*([^*]+)\*\*\s*$/.exec(l.text.trim());
      if (g) {
        group = g[1]!.trim();
        cur = null;
        continue;
      }
      const item = /^(\d+)\.\s+(.*)$/.exec(l.text);
      if (item) {
        let text = item[2]!.trim();
        const slice = /^\*\*\(slice\)\*\*\s*/.test(text);
        if (slice) text = text.replace(/^\*\*\(slice\)\*\*\s*/, "");
        cur = { number: Number(item[1]), text, slice, group };
        out.push(cur);
      } else if (cur && /^\s+\S/.test(l.text)) {
        cur.text += ` ${l.text.trim()}`;
      } else if (!l.text.trim()) {
        cur = null;
      }
    }
  }
  return out;
}

// ── import request / response shapes (shared by API, CLI and MCP) ──────────

export type PlanEvidenceState = Extract<IssueState, "backlog" | "todo" | "in_progress" | "done">;

export interface PlanEvidencePr {
  /** "owner/repo" */
  repo: string;
  number: number;
}

export interface PlanEvidence {
  state?: PlanEvidenceState | undefined;
  prs?: PlanEvidencePr[] | undefined;
  /** ISO date the work merged */
  mergedAt?: string | undefined;
}

export interface PlanImportRequest {
  /** project id or exact project name */
  project: string;
  teamKey?: string | undefined;
  plan: {
    /** title namespace, e.g. "KP" gives "[KP-U3] ..." */
    scope: string;
    source: { repo: string; path: string; sha: string; url?: string | undefined };
    markdown: string;
  };
  /** unit id ("U12") -> state and PR links */
  evidence?: Record<string, PlanEvidence> | undefined;
  historical?: boolean | undefined;
  /** scoped unit id ("KP-U12") -> existing issue key, for ambiguous matches */
  resolutions?: Record<string, string> | undefined;
  mode?: "dry_run" | "apply" | undefined;
  /** hash from a reviewed dry run; required for apply */
  diffHash?: string | undefined;
}

export type PlanUnitAction = "create" | "update" | "unchanged" | "ambiguous" | "invalid";

export interface PlanImportCandidate {
  key: string;
  title: string;
  reason: "bare_id" | "multiple_scoped_id" | "similar_title";
  score?: number | undefined;
}

export interface PlanImportUnitResult {
  unitId: string;
  scopedId: string;
  title: string;
  action: PlanUnitAction;
  issueKey?: string | undefined;
  /** how an existing issue was found */
  matchedBy?: "ref" | "scoped_id" | "bare_id" | "github_link" | "resolution" | undefined;
  changes?: string[] | undefined;
  state?: IssueState | undefined;
  candidates?: PlanImportCandidate[] | undefined;
  reason?: string | undefined;
}

export interface PlanImportDiff {
  mode: "dry_run" | "apply";
  /** echo this back with mode "apply" */
  diffHash: string;
  counts: Record<PlanUnitAction, number>;
  units: PlanImportUnitResult[];
  milestones: { create: string[]; existing: string[] };
  warnings: string[];
  /** apply only: ids written */
  applied?: { created: { unitId: string | undefined; key: string }[]; updated: { unitId: string; key: string }[] };
}
