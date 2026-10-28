// Which issues does a pull request name? (U17, KTD7)
//
// - the branch name starts with a key (`tly-42-fix-it`): the issue is "branch"
//   linked and keeps the existing automation (open moves it to in progress,
//   review request to in review, merge to done)
// - `Closes|Fixes|Resolves TLY-42` in the title or body: "closes"; the issue
//   moves to done only when the PR merges into the default branch of a repo
//   bound to the issue's project (decided by the caller)
// - any other key in the title or body, `Refs TLY-42` included: "refs", link only

const KEY = String.raw`[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}`;
const KEY_RE = new RegExp(String.raw`\b(${KEY})\b`, "g");
const KEY_LIST = String.raw`${KEY}(?:\s*(?:,|&|and)\s*${KEY})*`;
const CLOSING_RE = new RegExp(
  String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(${KEY_LIST})`,
  "gi",
);
const BRANCH_RE = new RegExp(String.raw`^(${KEY})(?![A-Za-z0-9])`);

export interface PrReferences {
  /** key at the start of the branch name, upper-cased */
  branchKey: string | null;
  /** keys named after a closing keyword */
  closes: string[];
  /** every other key named in the title or body */
  refs: string[];
}

const upper = (s: string) => s.toUpperCase();

export function parsePrReferences(input: {
  branch?: string | null;
  title?: string | null;
  body?: string | null;
}): PrReferences {
  const branchKey = input.branch ? (BRANCH_RE.exec(input.branch)?.[1] ?? null) : null;
  const text = `${input.title ?? ""}\n${input.body ?? ""}`;

  const closes = new Set<string>();
  for (const m of text.matchAll(CLOSING_RE)) {
    for (const k of m[1]!.matchAll(KEY_RE)) closes.add(upper(k[1]!));
  }
  const refs = new Set<string>();
  for (const m of text.matchAll(KEY_RE)) {
    const k = upper(m[1]!);
    if (!closes.has(k)) refs.add(k);
  }
  const bk = branchKey ? upper(branchKey) : null;
  if (bk) {
    closes.delete(bk);
    refs.delete(bk);
  }
  return { branchKey: bk, closes: [...closes], refs: [...refs] };
}

export type PrLinkState = "draft" | "open" | "merged" | "closed";

export function prLinkState(pr: { merged?: boolean; draft?: boolean }, action: string): PrLinkState {
  if (action === "closed") return pr.merged ? "merged" : "closed";
  return pr.draft ? "draft" : "open";
}
