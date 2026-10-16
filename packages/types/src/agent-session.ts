import { z } from "zod";

// Agent session protocol (plan L1). Status and activity vocab mirror
// Linear's AgentSession / AgentActivity so adapters map one-to-one.

export const agentSessionStatuses = [
  "pending",
  "active",
  "awaitingInput",
  "complete",
  "error",
  "stale",
  "stopping",
] as const;
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

export const TERMINAL_SESSION_STATUSES: ReadonlySet<AgentSessionStatus> =
  new Set(["complete", "error", "stale"]);

const text = z.string().min(1).max(4000);

export const agentActivityContentSchema = z.discriminatedUnion("type", [
  // agent is reasoning; the first one acknowledges the session
  z.object({ type: z.literal("thought"), body: text }),
  // agent performed a tool/step; `parameter` is free text, `result` optional
  z.object({
    type: z.literal("action"),
    action: z.string().min(1).max(200),
    parameter: z.string().max(4000).optional(),
    result: z.string().max(4000).optional(),
  }),
  // agent needs a human answer; session moves to awaitingInput
  z.object({ type: z.literal("elicitation"), body: text }),
  // agent's answer or deliverable; `final` closes the session
  z.object({
    type: z.literal("response"),
    body: text,
    final: z.boolean().optional(),
  }),
  // agent failed; session moves to error
  z.object({ type: z.literal("error"), body: text }),
  // human (or system) input to the agent; resumes awaitingInput
  z.object({ type: z.literal("prompt"), body: text }),
]);
export type AgentActivityContent = z.infer<typeof agentActivityContentSchema>;
export type AgentActivityType = AgentActivityContent["type"];

export const agentSignals = ["stop"] as const;
export type AgentSignal = (typeof agentSignals)[number];

export const agentActivityInputSchema = z.object({
  content: agentActivityContentSchema,
  ephemeral: z.boolean().optional(),
  signal: z.enum(agentSignals).optional(),
});
export type AgentActivityInput = z.infer<typeof agentActivityInputSchema>;

// Pure transition table. Returns the next status, or null when the
// activity is not allowed in the current status.
export function nextSessionStatus(
  current: AgentSessionStatus,
  input: AgentActivityInput,
): AgentSessionStatus | null {
  if (TERMINAL_SESSION_STATUSES.has(current)) return null;
  if (input.signal === "stop") return "stopping";
  const t = input.content.type;
  switch (current) {
    case "pending":
    case "active":
      if (t === "elicitation") return "awaitingInput";
      if (t === "error") return "error";
      if (t === "response" && input.content.final) return "complete";
      if (t === "prompt" && current === "pending") return null;
      return "active";
    case "awaitingInput":
      if (t === "prompt") return "active";
      if (t === "error") return "error";
      if (t === "thought") return "awaitingInput";
      return null;
    case "stopping":
      if (t === "response" || t === "thought") return "complete";
      if (t === "error") return "error";
      return null;
    default:
      return null;
  }
}
