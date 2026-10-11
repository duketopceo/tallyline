// 402 PLAN_LIMIT (PLAN-059): the API already words the message for people
// (which limit, how many, what to do next), so the UI shows it as is.
// Anything else keeps the caller's own fallback copy.

export interface PlanLimitError {
  code: "PLAN_LIMIT";
  message: string;
  limit: "seats" | "agents" | "agent_keys" | "agent_runs" | "workspaces";
  plan: string;
  max: number;
  used: number;
}

export function planLimitOf(status: number, body: unknown): PlanLimitError | null {
  const e = (body as { error?: Partial<PlanLimitError> } | null)?.error;
  if (status !== 402 || e?.code !== "PLAN_LIMIT" || typeof e.message !== "string") return null;
  return e as PlanLimitError;
}

/** the message to show for a failed response */
export async function failureMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as unknown;
  return planLimitOf(res.status, body)?.message ?? fallback;
}
