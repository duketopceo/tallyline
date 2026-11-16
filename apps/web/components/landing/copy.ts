// The landing page's own words, in one place so a test can hold them to the
// rules: honest about what Tallyline is (a self-hostable, agent-native issue
// tracker), no invented numbers or customers, and never the word "AI".
// Hosted list prices are the CE-PLAN §3.2 figures. Limits come from
// apps/api/src/plans.ts (Free, and Pro/Business mapped to today's team row).

export const REPO = "https://github.com/duketopceo/tallyline";

export const META = {
  title: "Tallyline: a self-hostable issue tracker for humans and agents",
  description:
    "Tallyline is a self-hostable, agent-native issue tracker. Humans and agents work one board, with scoped keys, a review queue and a full event log. Open source, AGPL-3.0.",
};

export const HERO = {
  eyebrow: "Open source · AGPL-3.0 · self-hostable",
  lede:
    "Tallyline is an agent-native issue tracker. Agents have identities, scoped keys, sessions and a review queue, so you can see which agent did what, approve at the edges, and undo anything.",
  primary: "Self-host free",
  note: "Run it on a VPS, a homelab or your laptop. Your issues stay on your machine.",
};

export const STATES = ["triage", "backlog", "todo", "in progress", "in review", "done"];

export const SELF_HOST = {
  heading: "Clone to board in ten minutes.",
  body: "AGPL-3.0 licensed. Docker Compose runs Postgres, the API and the web app. Your issues stay on your machine, and the app loads no third-party scripts or fonts.",
};

/** Yearly-billed list prices, USD per seat per month. Monthly billing is $2 more. */
export const HOSTED_PRICES = {
  proYearly: 8,
  proMonthly: 10,
  businessYearly: 14,
  businessMonthly: 16,
} as const;

export type LandingPlan = {
  name: string;
  price: string;
  period: string;
  billed: string;
  limits: string;
};

export const PRICING = {
  heading: "Self-host free. Hosted list prices are public; checkout is not open yet.",
  body: "Self-hosting costs nothing and has no seat limits. You cannot buy a hosted plan today. A hosted beta has no SLA: data may be lost.",
  plans: [
    {
      name: "Self-host",
      price: "$0",
      period: "forever",
      billed: "No seats to buy. Unlimited workspaces, seats, agents and agent runs.",
      limits: "Your issues stay on your machine.",
    },
    {
      name: "Free",
      price: "$0",
      period: "per month",
      billed: "No paid seat.",
      limits: "1 workspace, 3 seats, 3 agents, 1,000 agent runs a month.",
    },
    {
      name: "Pro",
      price: `$${HOSTED_PRICES.proYearly}`,
      period: "per seat / month",
      billed: `$${HOSTED_PRICES.proYearly} when billed yearly, $${HOSTED_PRICES.proMonthly} when billed monthly.`,
      limits: "No seat cap once checkout exists. 25,000 agent runs a month.",
    },
    {
      name: "Business",
      price: `$${HOSTED_PRICES.businessYearly}`,
      period: "per seat / month",
      billed: `$${HOSTED_PRICES.businessYearly} when billed yearly, $${HOSTED_PRICES.businessMonthly} when billed monthly.`,
      limits: "Same limits as Pro for now.",
    },
  ] satisfies LandingPlan[],
};

/** Every string above, flattened, for the copy test. */
export function allCopy(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  [META, HERO, STATES, SELF_HOST, PRICING].forEach(walk);
  return out;
}
