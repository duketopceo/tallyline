// Pure ratchet comparison for `pnpm lint:design`: a file may never exceed its allowlist
// count, and when it drops below the allowlist must be lowered in the same change.
export interface Entry {
  count: number;
  tracking: string;
}

export function ratchetFailures(counts: ReadonlyMap<string, number>, files: Record<string, Entry>): string[] {
  const out: string[] = [];
  for (const [f, n] of counts) {
    const a = files[f]?.count ?? 0;
    if (n > a) out.push(`FAIL ${f}: ${n} violations, allowlist permits ${a}. Use tokens, do not raise the allowlist.`);
  }
  for (const [f, e] of Object.entries(files)) {
    const n = counts.get(f) ?? 0;
    if (n < e.count) {
      out.push(
        `FAIL ${f}: now ${n} violations but allowlist says ${e.count}. Lower it (pnpm lint:design --update-allowlist); the count may only go down.`,
      );
    }
  }
  return out;
}
