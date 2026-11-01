import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs plugin without types
import silverLining from "../eslint/index.mjs";
import { ratchetFailures } from "../scripts/ratchet.ts";

const linter = new Linter();
const config = [
  {
    files: ["**/*.tsx"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "silver-lining": silverLining },
    rules: {
      "silver-lining/no-raw-color": "error" as const,
      "silver-lining/no-offscale-font": "error" as const,
      "silver-lining/no-palette-color": "error" as const,
    },
  },
];
const lint = (className: string) =>
  linter.verify(`export const x = <div className="${className}" />;`, config, "fixture.tsx").map((m) => m.message);

describe("design lint rules: className fixtures", () => {
  it.each([
    "bg-red-600",
    "text-white",
    "bg-black/50",
    "bg-[#fff]",
    "text-[13px]",
    "text-[11px]",
    "hover:bg-blue-500/20",
    "border-slate-700",
    "ring-offset-gray-900",
    "bg-[oklch(0.5_0.1_200)]",
    "shadow-[0_8px_28px_rgba(0,0,0,0.5)]",
    "text-lg",
  ])("flags %s", (cls) => {
    expect(lint(cls).length).toBeGreaterThan(0);
  });

  it.each([
    "bg-surface-2",
    "text-ink-muted",
    "border-lining",
    "bg-neutral",
    "bg-neutral-soft",
    "text-neutral",
    "text-micro",
    "text-xs",
    "text-body",
    "text-sm",
    "text-title",
    "text-headline",
    "text-2xl",
    "text-[length:var(--x)]",
    "bg-[var(--sl-canvas)]",
    "shadow-overlay",
    "shadow-[var(--shadow-x)]",
    "border-[1.5px]",
    "bg-transparent",
    "rounded-sm duration-(--duration-base) ease-standard",
  ])("passes %s", (cls) => {
    expect(lint(cls)).toEqual([]);
  });

  it("does not double count a raw hex", () => {
    expect(lint("bg-[#fff]")).toHaveLength(1);
  });
});

describe("ratchet", () => {
  const files = { "a.tsx": { count: 2, tracking: "t" } };
  it("passes at the exact count", () => {
    expect(ratchetFailures(new Map([["a.tsx", 2]]), files)).toEqual([]);
  });
  it("fails over the count", () => {
    expect(ratchetFailures(new Map([["a.tsx", 3]]), files)).toHaveLength(1);
  });
  it("fails under the count until the entry is lowered", () => {
    expect(ratchetFailures(new Map([["a.tsx", 1]]), files)).toHaveLength(1);
    expect(ratchetFailures(new Map(), files)).toHaveLength(1);
  });
  it("gives new files zero allowance", () => {
    expect(ratchetFailures(new Map([["new.tsx", 1]]), files)).toHaveLength(2);
  });
});
