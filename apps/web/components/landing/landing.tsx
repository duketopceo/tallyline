import Link from "next/link";
import type { ReactNode } from "react";
import { TallyMark } from "@/components/tally-mark";

const REPO = "https://github.com/duketopceo/tallyline";

function Glint({ label }: { label?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" className="inline shrink-0 fill-accent align-[-1px]" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <path d="M12 1l2.6 7.4L22 11l-7.4 2.6L12 21l-2.6-7.4L2 11l7.4-2.6Z" />
    </svg>
  );
}

function Key({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-xs border border-lining-strong bg-surface-2 px-1 font-mono text-[11px] text-ink-muted">{children}</kbd>;
}

// Real captures of the product on the seeded demo workspace (tools/e2e/scripts/
// landing-shots.mjs). Dark and light variants follow the system theme.
function Shot({ name, alt, priority = false }: { name: string; alt: string; priority?: boolean }) {
  return (
    <div className="overflow-hidden rounded-lg border border-lining-strong bg-surface-1">
      <div aria-hidden className="flex h-7 items-center gap-1.5 border-b border-lining bg-surface-2 px-3">
        <span className="h-2 w-2 rounded-full bg-lining-strong" /><span className="h-2 w-2 rounded-full bg-lining-strong" /><span className="h-2 w-2 rounded-full bg-lining-strong" />
      </div>
      <picture>
        <source media="(prefers-color-scheme: light)" srcSet={`/landing/${name}-light.webp`} />
        <img
          src={`/landing/${name}-dark.webp`}
          alt={alt}
          width={1280}
          height={800}
          decoding="async"
          loading={priority ? "eager" : "lazy"}
          {...(priority ? { fetchPriority: "high" as const } : {})}
          className="block h-auto w-full"
        />
      </picture>
    </div>
  );
}

const STATES = ["triage", "backlog", "todo", "in progress", "in review", "done"];

const MCP_CONFIG = `{
  "mcpServers": {
    "tallyline": {
      "command": "tallyline-mcp",
      "env": {
        "TALLYLINE_API_URL": "https://tally.example.com",
        "TALLYLINE_TOKEN": "tly_agt_…",
        "TALLYLINE_WORKSPACE": "acme"
      }
    }
  }
}`;

const MINT = `# a human mints the agent and its key; the key is shown once
curl -X POST $API/v1/workspaces/$WS/agents \\
  -d '{"name":"claude","harness":"claude-code"}'
curl -X POST $API/v1/workspaces/$WS/agents/$ID/keys \\
  -d '{"name":"laptop","scopes":["read","write"]}'`;

function Row({ id, eyebrow, title, children, shot, flip }: { id?: string; eyebrow: string; title: string; children: ReactNode; shot: ReactNode; flip?: boolean }) {
  return (
    <section id={id} className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 py-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className={flip ? "lg:order-2" : ""}>
        <p className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">{eyebrow}</p>
        <h2 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.4px]">{title}</h2>
        <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-ink-muted">{children}</div>
      </div>
      <div className={flip ? "lg:order-1" : ""}>{shot}</div>
    </section>
  );
}

export function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-surface-3 focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-20 border-b border-lining-faint bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2" aria-label="Tallyline home">
            <TallyMark size={20} />
            <span className="text-[15px] font-semibold tracking-tight">tallyline</span>
          </Link>
          <nav aria-label="Site" className="hidden items-center gap-5 text-[13px] text-ink-muted sm:flex">
            <a href="#jobs" className="hover:text-ink">Product</a>
            <a href="#provenance" className="hover:text-ink">Agents</a>
            <a href="#connect" className="hover:text-ink">Connect</a>
            <a href="#self-host" className="hover:text-ink">Self-host</a>
            <a href={REPO} className="hover:text-ink" target="_blank" rel="noreferrer">GitHub</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link href="/login" className="flex h-8 items-center rounded-sm border border-control px-3 text-[13px] text-ink-muted hover:bg-surface-2 hover:text-ink">Sign in</Link>
            <a href={REPO} target="_blank" rel="noreferrer" className="flex h-8 items-center rounded-sm bg-accent px-3 text-[13px] font-medium text-on-accent hover:bg-accent-hover">Self-host free</a>
          </div>
        </div>
      </header>

      <main id="main">
        <section className="mx-auto max-w-6xl px-6 pb-12 pt-16 text-center sm:pt-24">
          <p className="inline-flex items-center gap-2 rounded-full border border-lining-strong bg-surface-1 px-3 py-1 text-[12px] text-ink-muted">AGPL-3.0 · self-host or run it on your own box</p>
          <h1 className="mx-auto mt-6 max-w-3xl text-[24px] font-semibold leading-tight tracking-[-0.4px] sm:text-[24px]">One board for humans <span className="text-ink-subtle">and</span> agents.</h1>
          <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-ink-muted">
            Tallyline is an issue tracker where agents are teammates: they have identities, scoped keys, sessions and a review queue.
            You see which agent did what, approve at the edges, and undo anything.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a href={REPO} target="_blank" rel="noreferrer" className="flex h-10 items-center rounded-sm bg-accent px-5 text-[14px] font-medium text-on-accent hover:bg-accent-hover">Self-host free</a>
            <Link href="/login" className="flex h-10 items-center rounded-sm border border-control px-5 text-[14px] text-ink-muted hover:bg-surface-2 hover:text-ink">Sign in</Link>
          </div>
          <div className="mx-auto mt-12 max-w-5xl text-left">
            <Shot name="board" alt="The Tallyline board: columns for triage, backlog, todo, in progress and in review, with people shown as initials and agents shown with the glint" priority />
            <p className="mt-3 text-center text-[12px] text-ink-subtle">The board on a seeded demo workspace. People show as initials; the <Glint label="agent glint" /> glint marks anything an agent filed or holds.</p>
          </div>
        </section>

        <section aria-label="States" className="border-y border-lining-faint bg-surface-1">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-2 gap-y-2 px-6 py-4 text-[12px]">
            <span className="mr-2 text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">One state machine for everyone</span>
            {STATES.map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                <span className="rounded-full border border-lining-strong bg-surface-2 px-2.5 py-0.5 text-ink-muted">{s}</span>
                {i < STATES.length - 1 && <span aria-hidden className="text-ink-subtle">→</span>}
              </span>
            ))}
          </div>
        </section>

        <div id="jobs">
          <Row eyebrow="Give agents a board" title="Agents work the board, not around it." shot={<Shot name="list" alt="The issue list with the peek panel open on an issue assigned to an agent, showing its running session" />}>
            <p>Register an agent, mint a scoped key, and it claims, moves and comments under its own name. Same rules, same event log, same state machine as everyone else.</p>
            <p>Assign an issue to an agent and a durable dispatch starts its session. The list shows who holds what, and <Key>Space</Key> peeks at the session without leaving the list.</p>
          </Row>
          <Row eyebrow="Keep a human in the loop" title="Review is a first-class view." flip shot={<Shot name="review" alt="The review queue: finished agent work on the left, the agent's report and session on the right, with Approve and Send back actions" />}>
            <p>Finished agent work lands in one queue, oldest first, with what the agent reported, its session log and the pull request. <Key>a</Key> approves. <Key>r</Key> sends it back with a note the agent receives.</p>
            <p>Approvals are held for eight seconds with Undo, so there is no confirm dialog to click through.</p>
          </Row>
          <Row id="provenance" eyebrow="Everything attributable" title="Know which agent changed what." shot={<Shot name="issue" alt="An issue with its properties, an agent session card and an activity log showing who changed the state" />}>
            <p>The glint appears wherever an agent acted. It names the agent, links to its session, and the activity log shows before and after with a Revert on each agent change.</p>
            <p>When an agent makes fifty changes in a minute, they collapse into one entry you can expand.</p>
          </Row>
        </div>

        <section aria-label="Keyboard" className="border-y border-lining-faint bg-surface-1">
          <div className="mx-auto max-w-6xl px-6 py-14">
            <h2 className="text-[17px] font-semibold tracking-[-0.2px]">Fast enough to leave open all day</h2>
            <p className="mt-2 max-w-2xl text-[14px] text-ink-muted">Every action is reachable from the keyboard and from <Key>⌘K</Key>. Changes apply instantly and roll back visibly if the server says no.</p>
            <dl className="mt-8 grid gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["j k  x  Space", "Move, select, peek"],
                ["s  p  a", "State, priority, assignee on any issue"],
                ["g b  g t  g r", "Board, triage, review"],
                ["⌘Z", "Undo the last change, for eight seconds"],
              ].map(([k, d]) => (
                <div key={k}>
                  <dt className="flex flex-wrap gap-1">{k!.split(/\s+/).map((x, i) => <Key key={i}>{x}</Key>)}</dt>
                  <dd className="mt-2 text-[13px] text-ink-muted">{d}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section id="connect" className="mx-auto max-w-6xl px-6 py-16">
          <p className="text-[11px] font-medium uppercase tracking-[0.4px] text-ink-subtle">Route work in and out</p>
          <h2 className="mt-2 text-[24px] font-semibold leading-tight tracking-[-0.4px]">Three ways in for agents.</h2>
          <p className="mt-3 max-w-2xl text-[14px] leading-relaxed text-ink-muted">An MCP server for Claude Code, Cursor and Codex, a CLI with stable exit codes and <span className="font-mono text-[12px]">--json</span>, and a REST API with an OpenAPI document. Intake from GitHub, Slack and the API lands in triage; signed webhooks go out.</p>
          <div className="mt-8 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <figure className="min-w-0 rounded-md border border-lining-strong bg-surface-1">
              <figcaption className="border-b border-lining px-4 py-2 text-[12px] text-ink-subtle">MCP config for Claude Code or Cursor</figcaption>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-ink-muted"><code>{MCP_CONFIG}</code></pre>
            </figure>
            <figure className="min-w-0 rounded-md border border-lining-strong bg-surface-1">
              <figcaption className="border-b border-lining px-4 py-2 text-[12px] text-ink-subtle">Create an agent and its key</figcaption>
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-ink-muted"><code>{MINT}</code></pre>
            </figure>
          </div>
        </section>

        <section id="self-host" className="border-y border-lining-faint bg-surface-1">
          <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-10 px-6 py-16 lg:grid-cols-2">
            <div>
              <h2 className="text-[24px] font-semibold leading-tight tracking-[-0.4px]">Clone to board in ten minutes.</h2>
              <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">AGPL-3.0 licensed. Docker Compose runs Postgres, the API and the web app on a VPS, a homelab or your laptop. Your issues stay on your machine, and the app loads no third-party scripts or fonts.</p>
              <div className="mt-5 flex flex-wrap gap-3">
                <a href={`${REPO}/blob/main/docs/deploy.md`} target="_blank" rel="noreferrer" className="flex h-9 items-center rounded-sm border border-control px-4 text-[13px] text-ink hover:bg-surface-2">Read the deploy guide</a>
                <a href={REPO} target="_blank" rel="noreferrer" className="flex h-9 items-center rounded-sm bg-accent px-4 text-[13px] font-medium text-on-accent hover:bg-accent-hover">Star on GitHub</a>
              </div>
            </div>
            <figure className="min-w-0 rounded-md border border-lining-strong bg-canvas">
              <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-6 text-ink-muted"><code>{`git clone ${REPO}
cd tallyline
docker compose -f docker-compose.selfhost.yml up -d
# open http://localhost:3100 and create the first workspace`}</code></pre>
            </figure>
          </div>
        </section>

        <section aria-label="Pricing" className="mx-auto max-w-6xl px-6 py-16 text-center">
          <h2 className="text-[17px] font-semibold tracking-[-0.2px]">Free to run. Hosted plans are not available yet.</h2>
          <p className="mx-auto mt-2 max-w-xl text-[14px] text-ink-muted">Self-hosting costs nothing and has no seat limits. A hosted beta is planned, with no SLA while it is in beta: data may be lost.</p>
        </section>
      </main>

      <footer className="border-t border-lining-faint">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-6 text-[12px] text-ink-subtle">
          <span className="flex items-center gap-2"><TallyMark size={14} /> tallyline</span>
          <a href={REPO} target="_blank" rel="noreferrer" className="hover:text-ink">GitHub</a>
          <a href={`${REPO}/blob/main/docs/deploy.md`} target="_blank" rel="noreferrer" className="hover:text-ink">Docs</a>
          <a href={`${REPO}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer" className="hover:text-ink">Security</a>
          <a href={`${REPO}/blob/main/LICENSING.md`} target="_blank" rel="noreferrer" className="hover:text-ink">AGPL-3.0 license</a>
          <span className="ml-auto">humans, agents, one state machine</span>
        </div>
      </footer>
    </div>
  );
}
