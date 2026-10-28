import { accent, bad, bold, dim, mut, ok, warn } from "../pretty.js";
import type { Friendly } from "./errors.js";

// Pure string builders. Nothing here touches the terminal, so every screen is
// unit-testable and the same builders feed the demo recording.

export type Level = "ok" | "warn" | "fail" | "info";

const MARK: Record<Level, [string, (s: string) => string]> = {
  ok: ["✔", ok],
  warn: ["▲", warn],
  fail: ["✖", bad],
  info: ["·", mut],
};

export function mark(level: Level): string {
  const [g, c] = MARK[level];
  return c(g);
}

export function statusLine(level: Level, text: string, note?: string): string {
  return `${mark(level)} ${text}${note ? `  ${dim(note)}` : ""}`;
}

export function section(title: string, lines: string[]): string {
  return [bold(title), ...lines.map((l) => `  ${l}`)].join("\n");
}

export function nextSteps(steps: [command: string, what: string][]): string {
  const w = Math.max(...steps.map(([c]) => c.length));
  return section(
    "Next",
    steps.map(([c, what]) => `${accent(c.padEnd(w))}   ${dim(what)}`),
  );
}

export function errorBlock(f: Friendly): string {
  const lines = [`${bad("✖")} ${bold(f.title)}`];
  if (f.why) lines.push("", `  ${f.why}`);
  if (f.fix) {
    const isCmd = /^tallyline\b/.test(f.fix);
    lines.push("", `  ${dim("Try")}      ${isCmd ? accent(f.fix) : f.fix}`);
  }
  lines.push(`  ${dim("Details")}  ${dim(f.ref)}`);
  return lines.join("\n");
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (Number.isNaN(s)) return "";
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}
