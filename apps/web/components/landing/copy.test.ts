import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allCopy, META, REPO } from "./copy";

const landingSource = readFileSync(new URL("./landing.tsx", import.meta.url), "utf8");

describe("landing copy", () => {
  it("never uses the word AI, in the copy module or the page source", () => {
    for (const s of [...allCopy(), landingSource]) expect(s).not.toMatch(/\bAI\b/);
  });

  it("carries no invented numbers, customers or testimonials", () => {
    for (const s of allCopy()) {
      expect(s, s).not.toMatch(/\d+\s*%/);
      expect(s, s).not.toMatch(/trusted by|loved by|used by|customers|testimonial|\d+[kK+]\s+(users|teams|stars)/i);
    }
  });

  it("states what the product is", () => {
    const text = allCopy().join(" ");
    expect(text).toMatch(/self-host/i);
    expect(text).toMatch(/agent-native/i);
    expect(META.title.length).toBeLessThanOrEqual(70);
    expect(META.description.length).toBeLessThanOrEqual(200);
  });

  it("links the repo over https", () => {
    expect(REPO).toMatch(/^https:\/\/github\.com\//);
  });
});
