// Renders docs/design/ux-scorecard.md from the scores below.
// node tools/e2e/scripts/scorecard.mjs > docs/design/ux-scorecard.md
const DIMS = ["Hierarchy", "Density", "Type", "Color", "Keyboard", "Feedback", "States", "Mobile", "Agent"];
const before = JSON.parse(process.env.BEFORE ?? "null") ?? {};
export const BEFORE = {
  "App shell + sidebar": [5, 6, 5, 7, 6, 4, 5, 2, 5],
  "My Issues": [5, 6, 5, 6, 6, 4, 6, 2, 5],
  "All Issues": [5, 7, 5, 6, 6, 3, 5, 2, 5],
  "Board": [5, 6, 5, 6, 6, 4, 4, 2, 5],
  "Issue detail": [4, 4, 5, 5, 4, 3, 4, 3, 5],
  "Triage": [5, 6, 5, 6, 7, 3, 6, 2, 4],
  "Review queue": [5, 6, 5, 6, 7, 3, 5, 3, 5],
  "Cycle": [4, 5, 5, 5, 4, 3, 4, 2, 4],
  "Roadmap": [6, 6, 5, 6, 6, 4, 4, 3, 3],
  "Insights": [3, 5, 4, 3, 2, 2, 3, 3, 3],
  "Palette + keymap": [6, 6, 6, 6, 7, 5, 5, 5, 3],
  "Landing (/)": [6, 7, 6, 6, 5, 5, 5, 5, 4],
  "Login": [6, 6, 6, 7, 6, 5, 5, 6, 5],
};
const avg = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
let md = "# Tallyline UX scorecard (baseline, 2026-10-11)\n\nScored 1-10 from screenshots of main@1d0c1e7 on a seeded workspace (3 teams, 120 issues, 3 agents, 38 sessions), 1440 and 390, dark and light. Screens: docs/screenshots/ux-core/before-*.png.\n\n";
md += `| Screen | ${DIMS.join(" | ")} | Avg |\n|---|${DIMS.map(() => "---").join("|")}|---|\n`;
for (const [k, v] of Object.entries(Object.keys(before).length ? before : BEFORE)) md += `| ${k} | ${v.join(" | ")} | **${avg(v)}** |\n`;
md += `
## Findings that drive the score

- Mobile (390px): the 208px sidebar is permanent, so every screen shows about 180px of content. Issue titles truncate to one letter. Mobile scores 2-3 everywhere.
- No feedback loop: every mutation is a blocking fetch followed by router.refresh(). No optimistic update, no undo, no toast, failures are silent on lists.
- Issue lists are read-only: no inline edit of state, priority or assignee; no assignee shown at all; no filters, no saved views (the views API exists and is unused); selection only supports x, no bulk actions beyond triage a/d.
- Issue detail edits only state (buttons), cycle and project (native selects). Priority is text, no assignee/labels/estimate/due editing; the agent-created pill says "via web" while the session timeline shows nothing about what changed.
- Provenance is a lone glint. It does not say which agent, which session, or what it changed.
- Board is 8 columns wide with no scroll cue and empty columns taking space. Peek does not exist anywhere.
- Insights: raw floats on the axis (1.4e-7d), indigo/violet series outside the status palette, one data point rendered as a full-width bar.
- Cycle page is three stacked UIs (list, management table, create form) with native date inputs.
- Landing page ships stale docketry screenshots and a black empty panel in the agents section.
- Dev-only Next badge overlaps Sign out (dev only, not scored).
`;
console.log(md);
