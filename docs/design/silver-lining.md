# Silver Lining: foundation and rules

Silver Lining is the shared interface foundation for the owner's operator tools. It covers:

- **Tallyline**, the web app: issues, board, triage, review, cycles, roadmap.
- **open-computer**, the control-plane console: sandboxes, router, approvals, audit.
- **Silver Lining itself**: the tokens, components and rules both products inherit.

The target is Linear-level quality as an open-source tool, adapted for one operator who runs agents all day and keeps these screens open for hours.

`DESIGN.md` holds the token values. This document holds the rules those values serve. When they disagree, this document wins and `DESIGN.md` gets fixed.

Every rule below is either checked by a gate (section 13) or marked *review* when only a human can judge it.

---

## 1. Principles

1. **Calm by default, lit when it matters.** The resting state is quiet: dark neutrals, hairline edges, one accent. Brightness and color are spent only on what needs the operator: a blocked issue, a failed run, an approval waiting. A lit lining always comes with a recommended action.
2. **The keyboard is the primary input.** Every action can be reached without a pointer. The mouse is a convenience.
3. **Content over chrome.** Navigation, headers and toolbars recede. The operator's issues, runs and logs carry the visual weight.
4. **Speed is a feature.** Interactions feel instant. Waiting is designed, never accidental.
5. **State is never lost.** Filters, scroll position, drafts, pane sizes and collapsed sections survive navigation and reloads.
6. **Agents are first-class and always attributed.** Anything an agent did is visibly marked, traceable to its session, and reversible by a human.
7. **Comfortable for long sessions.** If a choice looks better in a screenshot but tires the eyes after four hours, the comfortable choice wins.
8. **One system, two products.** Tallyline and open-computer share tokens, components, shortcuts and copy rules. A user who knows one already knows the other.

---

## 2. Theme engine

Following Linear's approach, themes are generated, not hand-picked. Each theme is derived in OKLCH from three inputs:

| Input | Meaning | Default (dark) |
|---|---|---|
| `base` | Hue and lightness of the canvas | `oklch(0.16 0.012 255)` (≈ `#0a0c10`, cool silver cast) |
| `accent` | The single chromatic accent | `oklch(0.68 0.15 245)` (≈ `#3ea1f7`, signal azure) |
| `contrast` | 0–100; spreads the surface ladder and text steps | `30` |

From those three inputs the generator derives:

- **Surfaces:** the 4-step surface ladder (`surface-1..4`), each step +0.03 to +0.045 L from the previous.
- **Linings:** the 4 lining steps (`faint`, default, `strong`, `bright`).
- **Text:** the 4 text steps (`ink`, `muted`, `subtle`, `tertiary`).
- **Overlays:** overlay and scrim.

Status colors are **not** generated. They are fixed per theme (section 5), so meaning never shifts with taste.

Shipped themes: **Dark** (default), **Light**, **High contrast dark** (`contrast` = 70), and **Follow system**.

Users may set their own `base`, `accent` and `contrast`. The generator clamps every output so the contrast floors in section 3 still hold.

**Rules**

- The canvas is never `#000000`, and text is never `#ffffff`. Pure black and pure white cause halation and eye strain over long sessions. Darkest canvas L ≥ 0.13; brightest text L ≤ 0.96.
- The accent covers at most about 5% of any screen's pixels (*review*). If everything is blue, nothing is.
- No large saturated surfaces. Chroma above 0.08 is allowed only on elements of 32px height or less, such as pills, badges and the focus ring. Banners use the soft (14% alpha) variants.
- Theme switches apply instantly, with no reload, and persist per device.

---

## 3. Contrast floors

Floors are measured with WCAG 2.2 contrast against the actual surface behind the text. The gate is axe plus a token contrast test.

| Text role | Dark floor | Dark ceiling | Light floor |
|---|---|---|---|
| Primary text (`ink`) | 12:1 | 16:1 | 12:1 |
| Secondary (`ink-muted`) | 7:1 | — | 7:1 |
| Tertiary or metadata (`ink-subtle`, `ink-tertiary`) | 4.5:1 | — | 4.5:1 |
| Disabled | 3:1 (and never the only signal) | — | 3:1 |
| UI component edges (inputs, focus ring) | 3:1 | — | 3:1 |

The ceiling exists for comfort: past about 16:1 on a dark canvas, text starts to glow. These floors apply on every surface step text can sit on, not just the canvas.

---

## 4. Typography

- **Faces:**
  - **Atkinson Hyperlegible Next** for interface text, self-hosted (`@fontsource/atkinson-hyperlegible-next`), `font-feature-settings: "kern"`. It is chosen for legibility over long sessions — maximum character discrimination (l/I/1, O/0, rn/m) at 11–15px — not for how it screenshots. True italics for prose emphasis.
  - **Commit Mono** for issue keys, IDs, hashes, code and log lines — and for tabular numerals anywhere (counts, estimates, durations). Numerals that describe data are data; the mono face is the data face. Self-hosted (`@fontsource/commit-mono`).
  - **No template faces.** The primary UI face is a deliberate, licensed pick — never a platform default (Inter, Roboto, Geist, SF/system-ui) serving as the branded face. A face earns its place on legibility over hours and letterform distinction, not familiarity.
  - No third face.
- **Scale:** `micro 11 / caption 12 / body 13 / body-lg 14 / title 15 / headline 17 / display 24`. Nothing below 11px, anywhere.
- **Weights:** 400, 500 and 600 only. Emphasis comes from weight and ink step, not from size jumps or color. (The faces ship heavier files — the product doesn't use them.)
- **Measure:** running text (issue descriptions, docs) is 72ch at most. Lists and tables are not capped.
- **Truncation:** single-line titles truncate with an ellipsis and show the full text in a tooltip and the peek panel. Issue keys never truncate.
- Uppercase is used only for `micro` labels, with +0.4px tracking.

---

## 5. Color semantics

Color carries fixed meanings. A color is never reused for decoration.

| Meaning | Token | Used for |
|---|---|---|
| Urgent or failing | `status-urgent` (red) | Urgent priority, failed run, blocked by error, destructive action confirm |
| Needs attention | `status-attention` (amber) | High priority, waiting on approval, nearing budget or limit |
| Healthy or done | `status-healthy` (green) | Done, passed, approved |
| Neutral | `status-neutral` | Backlog, idle, cancelled |
| Accent | `accent` (azure) | Primary action, link, focus, selection, **agent provenance glint** |

- Blue is never a status color, and red is never used just to draw the eye.
- Status is never conveyed by color alone. It always pairs with an icon shape and a text label, which matters for color-blind users and for monochrome screenshots.
- The lining brightens (`lining-bright`) only on the element that needs action, never on whole regions.

---

## 6. Layout and density

- **Shell:** an inverted L. The sidebar on the left (232px default, resizable 200–320px, collapsible to 56px) holds workspace, views and navigation. The header strip (48px) holds the title, breadcrumbs, view controls and filter pills. Everything else is content.
- **Panes:** list → peek (right, 480–720px, resizable) → full detail. Pane widths persist per view.
- **Grid:** 4px base. Use spacing tokens only: `2 4 8 12 16 24 32 64`.
- **Density modes,** chosen per user:

  | Mode | Row height | Notes |
  |---|---|---|
  | Compact | 32px | — |
  | Default | 36px | — |
  | Comfortable | 40px | Default on touch |

  Switching density changes only row height and vertical padding. Nothing reflows horizontally.
- **Breakpoints:**
  - At 1440px and above, full shell plus peek.
  - From 1024px to 1439px, peek overlays the list.
  - From 640px to 1023px, the sidebar becomes a drawer.
  - Below 640px, single column, with a bottom action bar for the 4 most common actions.
- **No layout shift:** reserve space for async content. Skeletons match the final geometry.

---

## 7. Interaction rules

**Keyboard**

- `Cmd/Ctrl+K` opens the command palette. The palette covers 100% of actions available on screen, and a test enforces this (section 13).
- Single-key shortcuts act on the focused or selected item:
  - `c` create
  - `e` edit title
  - `s` state
  - `p` priority
  - `a` assignee
  - `l` labels
  - `x` select
  - `.` actions menu
- `g` then a letter navigates: `g i` my issues, `g b` board, `g t` triage, `g r` review, `g c` cycle, `g a` all issues, `g s` insights, `g p` roadmap, `g e` activity, `g ,` settings.
- `j`/`k` or the arrow keys move, `Enter` opens, `Space` peeks, `Esc` closes the topmost layer and returns focus to where it came from.
- `?` shows every shortcut for the current screen, generated from the same registry the palette uses.
- Shortcuts are identical in Tallyline and open-computer wherever the action exists in both.

**Feedback**

- **Optimistic by default:** the UI shows the result within 100ms and reconciles with the server afterward. If the server rejects the change, the UI rolls back visibly and the toast says why.
- **Undo, not confirm:** reversible actions (state, assignee, labels, archive, bulk edits) show a toast with `Undo` (`Cmd/Ctrl+Z`) for 8 seconds. Confirmation dialogs are reserved for irreversible actions: deleting a workspace, revoking all keys, purging data. Even then, the user types the name.
- **No modal stacking:** at most one modal. Pickers are popovers anchored to their trigger.
- **Inline edit everywhere:** title, state, priority, assignee, labels, estimate and cycle are editable in place, from lists, board and detail.
- **Multi-select:** `x`, Shift+click or Shift+J/K select. Bulk actions appear in a floating bar showing the selection count, and every bulk action is undoable.

---

## 8. Performance budgets

These are gates, not targets.

| Measure | Budget |
|---|---|
| Input → visual response | ≤ 100ms (p95) |
| Route change with cached data | ≤ 200ms |
| First load, LCP, on the deploy box over the tunnel | ≤ 1.5s |
| CLS | ≤ 0.02 |
| JS per route, gzipped | ≤ 180kB initial |
| List rendering | Virtualized above 200 rows; scrolling holds 60fps on 2,000 rows |
| Live updates | SSE events applied in batches at most every 250ms, never blocking input |

---

## 9. Long-session comfort

The rules that make an 8-hour day pleasant rather than tiring:

- **No motion at rest.** Nothing animates, pulses or blinks unless the operator just acted or something needs them. Spinners are banned in favor of skeletons. Progress for long jobs is a thin determinate bar.
- **Motion is short and purposeful:** 90–200ms, using `ease-standard` or `ease-out`. With `prefers-reduced-motion`, all transitions drop to 0ms except opacity fades of 90ms or less.
- **Notifications are batched and quiet:**
  - Agent activity updates the inbox count and the row in place, and never steals focus.
  - Toasts auto-dismiss, except error toasts that need a decision.
  - Sound is off unless the user turns it on.
- **No surprise layout changes.** Incoming live data never moves the row under the cursor or the keyboard focus. New items appear with a "3 new" pill the user clicks to reveal them.
- **Remembered state, per view and device:** filters, sort, grouping, scroll position, peek width, sidebar width and collapse state, density, theme, and unsent drafts (comments and descriptions autosave locally every 2s).
- **Readable at a glance from across the desk:** status icons stay recognizable at 16px, and the issue key plus title are the highest-contrast elements in a row.
- **Night use:** the theme follows the system by default. The dark theme's surfaces stay below L 0.30, so a dark room isn't lit by the UI.

---

## 10. Agent-native rules

- **Provenance glint:** the four-point glint (accent color) marks anything an agent created or changed: rows, comments, field changes and timeline entries. Hovering or focusing it shows the agent's name, session and time. Clicking it opens the session timeline.
- **Every agent change is attributable and reversible:** the activity log shows a diff (before → after) and a per-change `Revert`.
- **Humans approve at the edges:** review queues (Tallyline) and approval consoles (open-computer) use the same pattern:
  - A list of pending items, oldest first, each showing who asked, what will change, and what it will cost or risk.
  - `a` approves, `r` sends back with a required note, `Enter` opens the full context.
- **Agent sessions** show live status (running, waiting on human, done, failed) with the fixed status colors. A running session's row shows one short live line; full logs live in the session view.
- **Throttled presentation:** when an agent changes 50 things in a minute, the UI groups them into one summarized activity entry that expands to show each change.

---

## 11. Accessibility

- WCAG 2.2 AA is the floor. axe reports 0 violations on every screen in both themes at 1440px and 390px.
- **Focus:** a 2px `accent` ring with a 2px offset, always visible on keyboard focus. It is never removed, only restyled.
- **Targets:** at least 24×24px for pointers and 32×32px on touch breakpoints.
- Every icon-only control has an accessible name. Every form control has a label (visible, or `aria-label` for inline editors).
- Live regions announce toasts and completed async actions politely. Errors are announced assertively.
- Full keyboard operability is tested end to end (section 13), not assumed.

---

## 12. Copy rules

- Write from the operator's side: "Send back to agent", not "Set state to rejected".
- Buttons say exactly what happens: "Archive 3 issues", "Approve run", "Revoke key".
- Errors say what went wrong and what to do next, with no apology and no codes unless they help.
- Empty states say what will appear here and how to add the first item, with one primary action.
- Numbers are tabular, dates are relative within 7 days ("2h ago") with the absolute time on hover, and durations read like "4m 12s".
- One name per concept across both products: *workspace*, *team*, *issue*, *agent*, *session*, *run*, *approval*.

---

## 13. Enforcement: deterministic gates

Each gate runs in CI and fails the build.

| Gate | What it checks | Command |
|---|---|---|
| Token-only styling | No raw hex, rgb or hsl colors, and no px font sizes outside the token scale, in component code | `pnpm lint:design` (stylelint plus an ESLint rule on className and style) |
| Contrast | Every text-step × surface-step pair in every theme meets section 3 | `pnpm test:contrast` (computes from the generated tokens) |
| Theme parity | Tallyline and open-computer ship the same generated token set (hash match) | `pnpm test:token-parity` |
| Accessibility | axe at 0 violations, WCAG 2.2 AA, both themes, 1440 and 390, every route | `pnpm test:e2e --grep @a11y` |
| Palette coverage | Every registered action is in the palette and has a shortcut or a palette entry | `pnpm test:e2e --grep @palette` |
| Keyboard journeys | Create, triage, assign, bulk-edit, review and approve, completed with the keyboard only | `pnpm test:e2e --grep @keyboard` |
| Visual regression | Screenshot baselines per route × theme × breakpoint × density, 0.1% pixel tolerance | `pnpm test:visual` |
| Performance | Budgets in section 8 (Lighthouse CI plus an interaction-latency harness) | `pnpm test:perf` |
| No layout shift on live data | An SSE burst of 50 events moves neither focus nor the hovered row | `pnpm test:e2e --grep @live` |
| Hydration | 0 hydration warnings on every route | `pnpm test:e2e --grep @hydration` |

---

## 14. How open-computer adopts it

open-computer renders server-side from Python's standard library, with no build step. It adopts Silver Lining in four ways:

- **Shared tokens:** it vendors the generated `silver-lining.css` (CSS custom properties for every token and theme). A sync script copies it from Tallyline's build output, and the parity gate checks the hash.
- **Same shell and keyboard model:**
  - The sidebar becomes the console's sections: Overview, Sandboxes, Runs, Approvals, Router, Audit.
  - `Cmd/Ctrl+K` opens a palette over console actions.
  - `j`/`k`, `Enter`, `Esc` and `?` behave identically.
- **Console-specific patterns:**
  - Dense tables use the compact density.
  - Log streams use JetBrains Mono at 12px with line numbers, capped at 5,000 lines in the DOM and virtualized.
  - The approvals queue follows section 10 exactly.
  - Cost appears next to every action that spends money.
- **Its own safety rules:**
  - No GET request ever causes side effects. The current `GET /run` that boots microVMs must become a POST with a confirm step.
  - Anything that leaves the box shows its destination.

---

## 15. Where Tallyline departs from Linear, on purpose

- **Self-host first:** every screen works with no network calls beyond the operator's own API, and no third-party fonts or scripts in production.
- **Agents are teammates, not integrations:** they have identities, keys, sessions, provenance and a review queue.
- **The lining is functional:** Linear uses near-invisible borders. Silver Lining makes the edge itself the attention signal.
- **Review is a first-class view,** because most incoming work comes from agents.
- **No AI chrome:** no sparkles on buttons and no "AI" badges. The glint means exactly one thing: an agent touched this.

---

## 16. Edge states: loading, empty, error, degradation

The un-happy paths are designed surfaces, not afterthoughts. Every state below is a contract — if a surface can reach the state, the state must look intentional.

### Loading

- **Skeletons match final geometry exactly.** Same rows, same columns, same heights — the CLS budget (section 8) is a gate. Spinners remain banned.
- **Every routed surface ships a `loading.tsx`.** A route without a skeleton is a spec violation. The known gap: `notifications` and the `settings/*` tree.
- **Lazy surfaces acknowledge instantly, fill progressively.** The palette, quick-create, peek, pickers and keymap load their bodies on first use: the frame opens on the keypress and rows stream in — the trigger never waits on the chunk.
- **Slow path escalates quietly.** A skeleton visible longer than ~4 seconds gains one muted line ("Still loading — the API is slow to answer") plus a `button-secondary` Retry. No spinner swap, no page change.
- **Cold boot has one branded moment.** First paint into the app draws the tally strokes once — 300ms, struck through by the azure line, the mark itself. Under `prefers-reduced-motion` it renders static. It never appears between routes, on refetches, or more than once per app load.
- **Live data degrades to quiet.** When the event stream drops, a subtle "reconnecting" pill sits top-right; reads stay live, writes disable with the reason attached. The stream dying must never freeze reading.

### Empty

Four distinct flavors — never the same "nothing here":

| Flavor | Cause | Contract |
|---|---|---|
| First-run | Nothing exists yet | What appears here + how to create it (primary action or keycap) |
| Filtered-empty | Active filters hid everything | Say so + a one-click clear |
| Permission-empty | It exists, you can't see it | Say so + who can grant access |
| Error-empty | Data didn't load | Error copy + Retry — never masquerade as "empty" |

### Error

- **Isolate failures to the segment that failed.** Every route carries an `error.tsx` boundary; partial failures on a multi-fetch page render `error-panel` in the failing region only — a dead activity feed never blanks the issue.
- **`error-panel` for recoverable, route boundary for catastrophic, inline for validation.** No third class of error surface.
- **API unreachable:** content regions show `error-panel` + Retry; the shell stays navigable — the operator can always get to a page that works.
- **No codes unless they help.** "Could not sign in" — not "401".

### Degradation and concurrency

- **Deleted while viewing** → a "this issue was deleted" gone-state with a path back, not a bare 404.
- **409 conflict** → show the server's current truth beside the intended change and let the operator choose; never silently overwrite.
- **Ghost actors** (removed member, revoked agent) → name + "(removed)". Provenance survives account deletion — the record still says who did it.
- **Oversized:** lists virtualize above 200 rows; titles truncate with tooltip; label overflow collapses to a "+N" chip; long markdown lazy-renders below the fold.
- **Session expiry mid-draft:** drafts autosave locally every 2s; re-auth returns to the same draft. Auth dying never costs writing.
- **Double submit:** mutations disable while in flight; retries are idempotent, never duplicated.

---

## 17. Iconography

- **Phosphor** (MIT) via `@phosphor-icons/react` is the product's icon set — one library, one visual grammar. No hand-rolled UI icons.
- **Weight:** `regular` at 16px is the default glyph; `bold` marks active/emphasis states. `thin` is illegible at 16px on dark; `fill` and `duotone` fight the one-accent, four-status palette — all three are banned.
- **Sizes:** 16px standard (nav, rows, pickers, buttons); 20px for emphasis; never below 14px.
- **Color:** icons render `currentColor` — the ink step, status color or accent comes from the surrounding token, never a per-icon prop.
- **Brand exceptions stay custom:** the four-point **glint** and the **TallyMark** are owned geometry, not icon-set stock.
- **A11y:** every icon-only control carries an accessible name; status always pairs icon + label (section 5).
- **One import surface:** `components/app/icons.ts` names every icon the product uses. Components import the name, not the library — the set stays auditable and swap-able in one file.
## 18. Agent workspace

The pattern for watching and steering an agent working toward a goal. open-computer uses it as its main screen, a Perplexity Computer-style product. Tallyline uses a reduced version for agent sessions.

It's modeled on Perplexity Computer's context panel and opencode's right-side region. Sources and notes: `~/Downloads/claude/agent-workspace-research/REPORT.md`.

**The chat holds the story and the decisions. The right sidebar holds the state: what the agent knows, what it made, what would leave the box, and what it cost.**

### 18.1 Layout

| Column | Width | Contents |
|---|---|---|
| Left: goals | 240px, collapsible (`[`) | Goals grouped **Needs you · Running · Done · Failed**, with search and **New goal**. Pin and archive. |
| Center: conversation | Flexible, min 480px, content at most 760px | Title bar (status chip, elapsed time, spend/cap chip, context ring), timeline, composer. The composer region hosts the approval dock and queued messages. |
| Right: sidebar | 360px, resizable 280–560px, toggle `]` | The tabs in 16.2. Width persists per device. The toggle sits top-right and shows its shortcut in a tooltip. |

The spend/cap chip and the context ring (how full the context window is) are **always visible** in the title bar, whichever tab is open.

### 18.2 Sidebar tabs

Tabs are switched with `1`–`7` while the sidebar has focus, or from the palette. They don't use `g` shortcuts, which stay reserved for top-level navigation.

| # | Tab | Shows |
|---|---|---|
| 1 | **Progress** (default) | The plan as a checklist: pending, running (the only shimmering item), done, failed, skipped. Elapsed time per step. One row per sub-agent or sandbox, with **Stop** and **Send note**. |
| 2 | **Sources** | Deduplicated list. Each row has favicon, title, domain, how many times it's cited, and when it was fetched. Hovering shows the snippet. Clicking scrolls the chat to the first citation, and a citation clicked in chat highlights its row. A source the agent cited without fetching is flagged **Not verified**. |
| 3 | **Artifacts** | What the goal produced, grouped by type, with a version badge and an unreviewed dot. Opens in the panel's viewer (16.5). |
| 4 | **Changes** | Diff of the sandbox against its starting point (files, +/−), reviewable per hunk. This is what would leave the box. |
| 5 | **Outbox** | Everything that would leave the box (network egress, pushes, emails, spend), each pending, approved or denied, with who decided and when. Badge shows the pending count. |
| 6 | **Box** | Live view of the sandbox (terminal tail, browser frames when available), resource limits, the network allow-list and time to live. |
| 7 | **Cost** | Spend against the cap, tokens in, out and cached, split per model, context-window usage, and **Export run**. |

Tallyline's agent session view uses tabs 1, 2, 3, 5 and 7. It adds Changes only when the session edits files.

A **side chat** is optional: read-only questions about the run that never interrupt it.

### 18.3 Live updates

- **One event stream per goal.** The sidebar and timeline are pure projections of it, so reloading rebuilds exactly the same view. Event types:
  - `run`
  - `step`
  - `tool_call`
  - `source`
  - `artifact`
  - `change`
  - `approval`
  - `cost`
  - `note`
  - `error`
- **Never move what the user is looking at.** Scroll position, selected tab and focus stay put. New items appear behind an **N new** pill (section 9).
- **Pace updates:** coalesce to at most 4 per second, and only the single active item shimmers.
- **Tabs never switch on their own.** A new pending approval turns the Outbox badge amber and docks the approval card above the composer (16.4), without stealing focus.
- **Spend is always current.** Reaching 80% and 100% of the cap posts an inline event in the chat. At 100% the run **pauses** instead of cancelling, with a single **Raise cap and resume** action.
- **Background goals notify** only when they need approval, finish, fail or hit the cap. Notifications are deduplicated across windows, and the channel (toast or system notification) is a per-event setting.
- **On reconnect,** pending approvals are swept so none is missed, and a disconnected banner shows while the stream is down.

### 18.4 Approvals

- An approval is a **card in the timeline** at the moment of the request. While it's pending, **the same card docks above the composer**. It's never a modal.
- **The card states:**
  - the action
  - the destination (host or path)
  - the exact payload preview or diff
  - why the agent wants it
  - the cost impact
  - what happens if it's denied
- **Choices:**
  - **Allow once** (primary)
  - **Allow for this goal** (the scoped pattern is shown, for example `GET api.github.com/repos/duketopceo/*`)
  - **Deny** (with an optional note to the agent)

  There's no "always allow" by default: the box boundary is the product. High-risk items (risk = high, or spend above a threshold) render **Allow once** as a secondary button and require a second press. A risky approval is never a reflex.
- **Keys when the card has focus:** `a` allow once, `Shift+A` allow for this goal, `r` deny or send back with a note, `f` view the payload full screen. `Esc` defers without denying. These are the same keys as Tallyline's review queue (section 10).
- **Plan before spend:** goals estimated above a cost threshold draft a plan and wait for **Approve plan** before any paid call.
- **Loop guard:** after 3 identical tool calls in a row, the agent pauses and asks.
- **Resolved approvals** collapse to a single line in the timeline and remain in Outbox.
- **Binding:** an approval is tied to the payload hash and is single-use. Any change to the payload makes it a new request.

### 18.5 Artifacts and viewers

There's one artifact registry with one viewer per type:

| Type | Viewer |
|---|---|
| Markdown | Rendered, with export |
| HTML or app | Sandboxed iframe with no network; opening in a new tab is a separate, explicit action |
| Image, SVG | Image view |
| PDF | Document view |
| CSV or table | First 100 rows, with "Showing 100 of 4,210" |
| Office documents | Read-only preview |
| Code or text | Preview/Source toggle |
| Diff | Diff view |
| Mermaid | Rendered diagram |
| Audio, video | Media player |
| Archive | File listing |

- **Opening:**
  - A single click opens the artifact in the panel.
  - `Enter` or `f` expands it to a full-width overlay over the center column.
  - `Esc` returns.
- **The chat chip and the panel row are the same object.**
- **Every artifact shows:**
  - its version
  - the step that produced it
  - **Approve to export** if taking it out of the box needs approval

### 18.6 Citations

- **In chat:** numbered superscript chips `[1]`, with adjacent chips merging as `[1–3]`.
  - Hovering shows the favicon, title, domain and the quoted passage.
  - Clicking focuses and highlights the Sources row.
  - Keyboard: `Tab` reaches a chip, `Enter` jumps to it, `Esc` returns to where you were.
- **File citations** use `[path:line]` and open the Files or Changes viewer at that line.
- **Each source records:** URL, title, fetch time, content hash, which steps cited it, and whether it was actually fetched.

### 18.7 Keyboard

This adds to section 7; nothing here overrides it.

| Key | Action |
|---|---|
| `/` | Focus the composer |
| `Cmd/Ctrl+Enter` | Send |
| `[` / `]` | Toggle the left / right column |
| `1`–`7` | Sidebar tab (when the sidebar has focus) |
| `Shift+J` / `Shift+K` | Next / previous message |
| `.` | Stop the run (confirm with a second `.`) |
| `j` / `k`, `Enter`, `x` | Move, open, select in the goal list, Sources, Artifacts and Outbox |
| `g g` | Goals |
| `Cmd/Ctrl+K` | Search goals, artifacts, sources and commands |

Every key is listed in `?`, shown in tooltips and rebindable. No multi-key sequence waits longer than 1.5s.

### 18.8 Phone width (below 768px)

- **Layout:** chat only. The goal list becomes its own screen, and the sidebar becomes a **bottom sheet** with snap points (peek 30%, half, full), a handle and swipe-down to close.
- **A sticky strip above the composer** shows status, spend/cap and badge chips (Outbox N, Sources N, Artifacts N). Tapping a chip opens the sheet on that tab.
- **A pending approval** is a full-width card above the composer with large **Deny** and **Allow once** targets. It's the first thing shown when the app is opened from a notification.
- **Artifacts** open full screen with a back chevron.

### 18.9 Gates (added to section 13)

| Gate | What it checks | Command |
|---|---|---|
| Projection determinism | Replaying a recorded event stream twice gives identical sidebar and timeline DOM snapshots | `test:replay` |
| Approval safety | An approval can't be reused after a payload change; Esc never denies or approves; high-risk items need two presses | `test:e2e --grep @approval` |
| Live stability | A 200-event burst keeps scroll position, the selected tab and focus | `test:e2e --grep @live` |
| Artifact viewers | Every artifact type renders its fixture with axe at 0 violations; the HTML viewer can't reach the network | `test:e2e --grep @artifacts` |
