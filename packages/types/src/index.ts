export const ISSUE_STATES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "duplicate",
] as const;

export type IssueState = (typeof ISSUE_STATES)[number];

export const ACTIVE_STATES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
] as const satisfies readonly IssueState[];

export const TERMINAL_STATES = [
  "done",
  "canceled",
  "duplicate",
] as const satisfies readonly IssueState[];

export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

export type Priority = (typeof PRIORITIES)[number];

export const ACTOR_TYPES = ["human", "agent", "system"] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

export const ISSUE_KEY_PATTERN = /^([A-Z][A-Z0-9]*)-(\d+)$/;

export const ISSUE_SOURCES = [
  "web",
  "github",
  "slack",
  "api",
  "voice",
] as const;

export type IssueSource = (typeof ISSUE_SOURCES)[number];

export {
  canTransition,
  findPath,
  legalTransitions,
  InvalidTransitionError,
} from "./state-machine.js";
export * from "./compat.js";
export * from "./plan.js";
