// The landing page's own words, in one place so a test can hold them to the
// rules: honest about what Tallyline is (a self-hostable, agent-native issue
// tracker), no invented numbers or customers, and never the word "AI".

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

export const PRICING = {
  heading: "Free to run. Hosted plans are not available yet.",
  body: "Self-hosting costs nothing and has no seat limits. A hosted beta is planned, with no SLA while it is in beta: data may be lost.",
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
