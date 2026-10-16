import { describe, expect, it } from "vitest";
import {
  agentActivityInputSchema,
  nextSessionStatus,
  type AgentActivityInput,
  type AgentSessionStatus,
} from "./agent-session.js";

const thought: AgentActivityInput = { content: { type: "thought", body: "hm" } };
const action: AgentActivityInput = { content: { type: "action", action: "read" } };
const elicit: AgentActivityInput = { content: { type: "elicitation", body: "which?" } };
const response: AgentActivityInput = { content: { type: "response", body: "done" } };
const finalResponse: AgentActivityInput = {
  content: { type: "response", body: "done", final: true },
};
const error: AgentActivityInput = { content: { type: "error", body: "boom" } };
const prompt: AgentActivityInput = { content: { type: "prompt", body: "use A" } };
const stop: AgentActivityInput = { content: { type: "thought", body: "x" }, signal: "stop" };

describe("nextSessionStatus", () => {
  it.each<[AgentSessionStatus, AgentActivityInput, AgentSessionStatus | null]>([
    ["pending", thought, "active"],
    ["pending", action, "active"],
    ["pending", elicit, "awaitingInput"],
    ["pending", error, "error"],
    ["pending", finalResponse, "complete"],
    ["pending", prompt, null],
    ["active", response, "active"],
    ["active", finalResponse, "complete"],
    ["active", elicit, "awaitingInput"],
    ["active", prompt, "active"],
    ["awaitingInput", prompt, "active"],
    ["awaitingInput", thought, "awaitingInput"],
    ["awaitingInput", action, null],
    ["awaitingInput", error, "error"],
    ["stopping", response, "complete"],
    ["stopping", action, null],
    ["complete", thought, null],
    ["error", prompt, null],
    ["stale", thought, null],
  ])("%s + %j -> %s", (current, input, expected) => {
    expect(nextSessionStatus(current, input)).toBe(expected);
  });

  it("stop signal moves any live session to stopping", () => {
    for (const s of ["pending", "active", "awaitingInput"] as const) {
      expect(nextSessionStatus(s, stop)).toBe("stopping");
    }
    expect(nextSessionStatus("complete", stop)).toBeNull();
  });
});

describe("agentActivityInputSchema", () => {
  it("rejects unknown content types and empty bodies", () => {
    expect(
      agentActivityInputSchema.safeParse({ content: { type: "sing", body: "la" } }).success,
    ).toBe(false);
    expect(
      agentActivityInputSchema.safeParse({ content: { type: "thought", body: "" } }).success,
    ).toBe(false);
    expect(
      agentActivityInputSchema.safeParse({ content: { type: "thought", body: "ok" }, signal: "nap" })
        .success,
    ).toBe(false);
  });

  it("accepts each documented shape", () => {
    for (const input of [thought, action, elicit, response, finalResponse, error, prompt, stop]) {
      expect(agentActivityInputSchema.safeParse(input).success).toBe(true);
    }
  });
});
