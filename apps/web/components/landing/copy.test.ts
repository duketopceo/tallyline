import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allCopy, HOSTED_PRICES, META, PRICING, REPO } from "./copy";

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

  it("publishes the settled hosted list prices and self-host free", () => {
    const text = allCopy().join(" ");
    expect(text).toMatch(/self-host free/i);
    expect(PRICING.plans.map((p) => p.name)).toEqual(["Self-host", "Free", "Pro", "Business"]);
    const pro = PRICING.plans.find((p) => p.name === "Pro");
    const business = PRICING.plans.find((p) => p.name === "Business");
    expect(pro?.price).toBe(`$${HOSTED_PRICES.proYearly}`);
    expect(business?.price).toBe(`$${HOSTED_PRICES.businessYearly}`);
    expect(pro?.billed).toContain(`$${HOSTED_PRICES.proMonthly}`);
    expect(business?.billed).toContain(`$${HOSTED_PRICES.businessMonthly}`);
    expect(HOSTED_PRICES).toEqual({ proYearly: 8, proMonthly: 10, businessYearly: 14, businessMonthly: 16 });
    expect(text).toMatch(/1 workspace, 3 seats, 3 agents, 1,000 agent runs a month/);
    expect(text).toMatch(/25,000 agent runs a month/);
  });

  it("does not offer checkout or a buy action", () => {
    const text = allCopy().join(" ");
    expect(text).toMatch(/checkout is not open yet/i);
    expect(text).toMatch(/you cannot buy a hosted plan today/i);
    expect(landingSource).not.toMatch(/buy now|subscribe|start trial|add to cart/i);
    expect(landingSource).not.toMatch(/<button/i);
  });

  it("renders the pricing plans from the copy module", () => {
    expect(landingSource).toMatch(/id="pricing"/);
    expect(landingSource).toContain("PRICING.plans.map");
    expect(landingSource).toContain('href="#pricing"');
  });
});
