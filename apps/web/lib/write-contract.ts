// Write contract C6 on the web: one way to send an issue patch with the
// version the edit was made against, and one way to read the answer.
//
// - `If-Match: <version>` is sent only when the caller knows the version; no
//   version means no precondition (the API treats it as an unconditional write).
// - `409 STALE_WRITE` (body: `{ error: { code, message }, issue }`, the same
//   shape as STALE_DIFF) means the issue changed since the version was read;
//   nothing was written and `issue.version` is the version to resolve against.
// - Anything else non-2xx is a plain error with the server's message.

export type PatchResult =
  | { kind: "ok"; version: number | null }
  | { kind: "stale"; version: number | null; message: string }
  | { kind: "error"; message: string };

interface Body {
  error?: { code?: string; message?: string };
  issue?: { version?: unknown };
  version?: unknown;
}

const asVersion = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

export async function sendIssuePatch(
  key: string,
  body: Record<string, unknown>,
  version?: number,
  doFetch: typeof fetch = fetch,
): Promise<PatchResult> {
  let res: Response;
  try {
    res = await doFetch(`/api/issues/${key}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(version !== undefined ? { "if-match": String(version) } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "error", message: "network unreachable" };
  }
  const data = (await res.json().catch(() => null)) as Body | null;
  if (res.ok) return { kind: "ok", version: asVersion(data?.version) };
  if (res.status === 409 && data?.error?.code === "STALE_WRITE") {
    return { kind: "stale", version: asVersion(data.issue?.version), message: data.error.message ?? "changed elsewhere" };
  }
  return { kind: "error", message: data?.error?.message ?? `server returned ${res.status}` };
}

/** The newer of two known versions: a write's own response can run ahead of props that have not refreshed yet. */
export const latestVersion = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.max(a, b);
