// Issue links and re-keying after a team move. Pure so both are testable
// without a DOM.

/** The API's computed `url`; an older server without it falls back to the current page. */
export function issueLink(issue: { url?: string | null | undefined }, fallback: string): string {
  return issue.url ? issue.url : fallback;
}

/** After a team move the issue has a new key; the open `/issues/<old>` page follows it. */
export function pathAfterMove(pathname: string, oldKey: string, newKey: string | undefined): string | null {
  if (!newKey || newKey === oldKey) return null;
  return pathname === `/issues/${oldKey}` ? `/issues/${newKey}` : null;
}
