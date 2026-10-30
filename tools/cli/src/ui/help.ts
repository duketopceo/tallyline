import { accent, bold, dim } from "../pretty.js";

// Grouped command list for interactive terminals. Plain `HELP` stays the
// non-TTY text. help.test.ts fails if a command is registered but not listed.

export const GROUPS: { title: string; items: [name: string, what: string][] }[] = [
  {
    title: "Work",
    items: [
      ["ready", "issues you can pick up now"],
      ["next", "what to do next"],
      ["claim", "take an issue"],
      ["start", "begin working on it"],
      ["done", "finish it (steps through review)"],
      ["comment", "add a note"],
      ["state", "move an issue to a specific state"],
    ],
  },
  {
    title: "Find and file",
    items: [
      ["list", "browse issues with filters"],
      ["search", "find issues by words"],
      ["show", "see one issue and its thread"],
      ["create", "file a new issue"],
      ["triage", "accept or decline new issues"],
      ["teams", "list or create teams"],
    ],
  },
  {
    title: "Plans and agents",
    items: [
      ["import-plan", "turn a plan document into issues"],
      ["events", "watch the live activity feed"],
      ["session", "post progress from a running agent"],
      ["work", "run dispatched work in this repo"],
    ],
  },
  {
    title: "Set up",
    items: [
      ["setup", "set up your own Tallyline on this computer"],
      ["resume", "start your Tallyline again after a stop"],
      ["stop", "pause your Tallyline (your data stays)"],
      ["backup", "save a copy of your data now"],
      ["update", "update your Tallyline"],
      ["connect", "sign in to your Tallyline"],
      ["doctor", "check everything is healthy, and fix what's easy"],
      ["status", "see who and where you are connected"],
      ["config", "view or change saved settings"],
      ["disconnect", "forget the saved sign-in"],
      ["init", "save workspace settings in this folder"],
    ],
  },
];

export function prettyHelp(version: string): string {
  const w = Math.max(...GROUPS.flatMap((g) => g.items.map(([n]) => n.length)));
  const out = [
    `${accent("✦")} ${bold("tallyline")} ${dim(`v${version}`)}   ${dim("(short name: tly)")}`,
    "",
  ];
  for (const g of GROUPS) {
    out.push(bold(g.title));
    for (const [n, what] of g.items)
      out.push(`  ${accent(n.padEnd(w))}   ${dim(what)}`);
    out.push("");
  }
  out.push(
    dim("Details for any command:  tallyline help <command>"),
    dim("Scripts and agents:       add --json for machine-readable output"),
  );
  return out.join("\n");
}
