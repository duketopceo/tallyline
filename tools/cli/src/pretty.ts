// Zero-dependency ANSI layer — human output only. Enabled once in cli.ts from
// TTY + NO_COLOR/FORCE_COLOR/--no-color; when off, every formatter falls back
// to the byte-identical legacy strings so --json, pipes and tests never move.

let enabled = false;
export function setColor(on: boolean): void {
  enabled = on;
}
export function colorOn(): boolean {
  return enabled;
}

const wrap = (code: string) => (s: string) =>
  enabled ? `[${code}m${s}[0m` : s;

export const accent = wrap("38;5;75"); // glint blue
export const bold = wrap("1");
export const dim = wrap("2");
export const ok = wrap("32");
export const warn = wrap("33");
export const bad = wrap("31");
export const mut = wrap("38;5;102");
export const mag = wrap("35");

// State glyph + tint — mirrors the web board's state chips.
const STATE_STYLE: Record<string, [string, (s: string) => string]> = {
  triage: ["◌", warn],
  backlog: ["○", mut],
  todo: ["◔", bold],
  in_progress: ["◐", accent],
  in_review: ["◕", mag],
  done: ["●", ok],
  canceled: ["◍", dim],
  duplicate: ["≡", dim],
};

export function stateGlyph(state: string): string {
  const [g, c] = STATE_STYLE[state] ?? ["·", mut];
  return enabled ? c(g) : "";
}

// Like stateGlyph, but the shape survives NO_COLOR (interactive screens only).
export function stateMark(state: string): string {
  const [g, c] = STATE_STYLE[state] ?? ["·", mut];
  return c(g);
}

export function stateText(state: string): string {
  const [, c] = STATE_STYLE[state] ?? ["", mut];
  return enabled ? c(state) : state;
}

// Priority bars — Linear-style rising blocks, urgent burns red.
const PRIORITY_BAR: Record<string, string> = {
  none: " ",
  low: "▁",
  medium: "▄",
  high: "▆",
  urgent: "█",
};

export function priorityGlyph(priority: string): string {
  const bar = PRIORITY_BAR[priority] ?? " ";
  if (!enabled) return "";
  return priority === "urgent" ? bad(bar) : mut(bar);
}

// The brand mark in ASCII: glint + tally strokes.
export const GLINT = "✦";
export const TALLY = "||||";

export function banner(version: string): string {
  const word = [
    `▀█▀ ▄▀█ █   █   █ █ █ █▄ █ ██▀`,
    ` █  █▀█ █▄▄ █▄▄ █▄█ █ █ ▀█ █▄▄`,
  ];
  if (!enabled) {
    return `${GLINT} ${word.join("\n  ")}\n${TALLY} issue tracking for humans + agents  v${version}`;
  }
  const strokes = accent(TALLY);
  return [
    `${accent(GLINT)} ${accent(word[0]!)}`,
    `  ${accent(word[1]!)}`,
    `${strokes}  ${dim(`issue tracking for humans + agents  v${version}`)}`,
  ].join("\n");
}

// Compact mark for --version and confirmations.
export function versionTag(version: string): string {
  return `${accent(GLINT)} ${bold(`tallyline`)} ${dim(`v${version}`)}`;
}

export function okLine(msg: string): string {
  return `${ok("✓")} ${msg}`;
}
