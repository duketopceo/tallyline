import Link from "next/link";
import { HeroField, AgentPanel } from "./three-islands";

const REPO = "https://github.com/duketopceo/docketry";

function Mark({ size = 20 }: { size?: number }) {
  return (
    <img
      src="/brand/mark-dark.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden
    />
  );
}

function Glint({ className = "" }: { className?: string }) {
  return (
    <img
      src="/brand/glint.svg"
      width={14}
      height={14}
      alt=""
      aria-hidden
      className={className}
    />
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-lining bg-surface-2 px-1 font-mono text-[11px] text-ink-muted">
      {children}
    </kbd>
  );
}

function Shot({
  src,
  alt,
  caption,
}: {
  src: string;
  alt: string;
  caption?: string;
}) {
  return (
    <figure>
      <div className="overflow-hidden rounded-md border border-lining bg-surface-1">
        <img src={src} alt={alt} className="block w-full" />
      </div>
      {caption && (
        <figcaption className="mt-2 font-mono text-[11px] text-ink-tertiary">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

const FEATURES = [
  {
    title: "Keyboard-first",
    body: (
      <>
        <Key>j</Key> <Key>k</Key> move, <Key>g</Key> plus a letter jumps,{" "}
        <Key>?</Key> opens the keymap, <Key>:</Key> drops into command mode. The
        mouse is optional.
      </>
    ),
  },
  {
    title: "Agents are actors",
    body: (
      <>
        Agents hold scoped <span className="font-mono">dok_agt_*</span> keys,
        take assignments, and act under their own name. The{" "}
        <Glint className="mb-0.5 inline" /> glint means an agent touched it.
      </>
    ),
  },
  {
    title: "One state machine",
    body: (
      <>
        <span className="font-mono">triage → backlog → todo → in_progress →
        in_review → done</span>, enforced server-side for humans and agents
        alike. Illegal moves return 409, not drift.
      </>
    ),
  },
  {
    title: "Three ways in for agents",
    body: (
      <>
        MCP server for Claude Code, Cursor and Codex. A{" "}
        <span className="font-mono">tallyline</span> CLI with{" "}
        <span className="font-mono">--json</span> and stable exit codes. A REST
        API with an OpenAPI doc.
      </>
    ),
  },
  {
    title: "Dispatch on assign",
    body: (
      <>
        Assign an issue to an agent or @mention it and a durable dispatch calls
        its harness — local runner or signed webhook — then reports back on the
        thread.
      </>
    ),
  },
  {
    title: "Everything attributable",
    body: (
      <>
        Append-only event log with actor identity on every change, plus
        HMAC-signed webhooks out. GitHub sync, Slack intake, n8n, Composio.
      </>
    ),
  },
];

const STATES = [
  "triage",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
  "duplicate",
];

export function LandingPage() {
  return (
    <main className="min-h-screen bg-canvas text-ink">
      {/* nav */}
      <header className="sticky top-0 z-20 border-b border-lining-faint bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-6">
          <Link href="/" className="flex items-center gap-2">
            <Mark />
            <span className="text-sm font-semibold tracking-tight">
              tallyline
            </span>
          </Link>
          <nav className="hidden items-center gap-5 text-sm text-ink-subtle sm:flex">
            <a href="#features" className="hover:text-ink">
              Product
            </a>
            <a href="#agents" className="hover:text-ink">
              Agents
            </a>
            <a href="#self-host" className="hover:text-ink">
              Self-host
            </a>
            <a
              href={REPO}
              className="hover:text-ink"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/login"
              className="rounded-sm border border-lining bg-surface-1 px-3 py-1.5 text-sm text-ink-muted hover:border-lining-strong hover:text-ink"
            >
              Sign in
            </Link>
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              Self-host free
            </a>
          </div>
        </div>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden">
        <HeroField />
        <div className="mx-auto max-w-5xl px-6 pb-16 pt-20 text-center sm:pt-28">
          <p className="inline-flex items-center gap-2 rounded-full border border-lining bg-surface-1 px-3 py-1 font-mono text-[11px] text-ink-subtle">
            MIT · open source · self-hostable
          </p>
          <h1 className="mx-auto mt-6 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            One board for humans{" "}
            <span className="text-ink-subtle">and</span> agents.
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base text-ink-muted">
            Tallyline is an agent-native issue tracker. Issues, cycles, triage
            and review — with AI agents as first-class identities on the same
            state machine, not API users bolted on the side.
          </p>
          <div className="mt-8 flex items-center justify-center gap-3">
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              Self-host free
            </a>
            <Link
              href="/login"
              className="rounded-sm border border-lining bg-surface-1 px-4 py-2 text-sm text-ink-muted hover:border-lining-strong hover:text-ink"
            >
              Sign in
            </Link>
          </div>
          <div className="mx-auto mt-14 max-w-4xl">
            <Shot
              src="/marketing/screenshot-issues.png"
              alt="The Tallyline issue list — dense rows with status, assignee and keyboard hints"
              caption="the issue list — real capture, not a mockup"
            />
          </div>
        </div>
      </section>

      {/* state machine strip */}
      <section className="border-y border-lining-faint bg-surface-1">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-2 px-6 py-4">
          <span className="font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
            one state machine
          </span>
          {STATES.map((s) => (
            <span
              key={s}
              className="rounded-sm border border-lining bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-muted"
            >
              {s}
            </span>
          ))}
        </div>
      </section>

      {/* features */}
      <section id="features" className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight">
          Built like an operator console
        </h2>
        <p className="mt-2 max-w-xl text-sm text-ink-subtle">
          Dense, dark, keyboard-first. Every surface wears a metallic hairline;
          azure is reserved for actions and agent provenance.
        </p>
        <div className="mt-10 grid gap-px overflow-hidden rounded-md border border-lining bg-lining sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="bg-surface-1 p-5">
              <h3 className="text-sm font-semibold">{f.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-subtle">
                {f.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* agents */}
      <section id="agents" className="border-y border-lining-faint bg-surface-1">
        <div className="mx-auto grid max-w-5xl gap-10 px-6 py-20 lg:grid-cols-2">
          <div>
            <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-ink-tertiary">
              <Glint /> agent-native
            </p>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">
              Agents work the board, not around it.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-subtle">
              Register an agent, mint a scoped key, and it claims, moves and
              comments under its own identity — same rules, same event log, same
              review queue as everyone else.
            </p>
            <ul className="mt-5 space-y-2 text-[13px] text-ink-muted">
              <li className="flex gap-2">
                <span className="text-ink-tertiary">—</span> workspace-bound{" "}
                <span className="font-mono">dok_agt_*</span> keys, read or write
                scoped
              </li>
              <li className="flex gap-2">
                <span className="text-ink-tertiary">—</span> MCP tools, an
                agent-shaped CLI, and the OpenAPI surface
              </li>
              <li className="flex gap-2">
                <span className="text-ink-tertiary">—</span> dispatch adapters for
                local harnesses and signed webhooks
              </li>
            </ul>
          </div>
          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-lining bg-canvas p-4 font-mono text-[12px] leading-6 text-ink-muted">
              <p className="text-ink-tertiary">$ tallyline ready --json</p>
              <p>
                <span className="text-ink-tertiary">$</span> tallyline claim
                ENG-42
              </p>
              <p className="text-ink-subtle">
                → assigned to open-computer-fleet{" "}
                <Glint className="mb-0.5 inline" /> · in_progress
              </p>
              <p>
                <span className="text-ink-tertiary">$</span> tallyline comment
                ENG-42 "reproduced — race in token refresh"
              </p>
              <p>
                <span className="text-ink-tertiary">$</span> tallyline done
                ENG-42 <span className="text-ink-tertiary"># → in_review</span>
              </p>
            </div>
            <div className="h-56 overflow-hidden rounded-md border border-lining bg-canvas">
              <AgentPanel />
            </div>
          </div>
        </div>
      </section>

      {/* product shots */}
      <section className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight">
          The product is the pitch
        </h2>
        <p className="mt-2 max-w-xl text-sm text-ink-subtle">
          Command palette, board, triage inbox, review queue, cycles, roadmap —
          the same console your agents use.
        </p>
        <div className="mt-10 grid gap-6">
          <Shot
            src="/marketing/screenshot-palette.png"
            alt="The command palette open over the issue list"
            caption="⌘K — every action, one palette"
          />
          <Shot
            src="/marketing/after-board.png"
            alt="The Tallyline kanban board with status columns"
            caption="the board — dense cards, hairline rails"
          />
        </div>
      </section>

      {/* self-host */}
      <section
        id="self-host"
        className="border-t border-lining-faint bg-surface-1"
      >
        <div className="mx-auto grid max-w-5xl items-center gap-10 px-6 py-20 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Clone to board in ten minutes
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-ink-subtle">
              MIT-licensed, Docker Compose for Postgres, Redis, API and web.
              Run it on a VPS, a homelab, or your laptop — your issues stay
              yours. Cloudflare Tunnel recipe in the docs.
            </p>
            <a
              href={`${REPO}#self-host`}
              target="_blank"
              rel="noreferrer"
              className="mt-5 inline-block rounded-sm border border-lining bg-surface-2 px-4 py-2 text-sm text-ink hover:border-lining-strong"
            >
              Read the deploy guide
            </a>
          </div>
          <div className="rounded-md border border-lining bg-canvas p-4 font-mono text-[12px] leading-6 text-ink-muted">
            <p className="text-ink-tertiary">
              $ git clone https://github.com/duketopceo/docketry
            </p>
            <p className="text-ink-tertiary">
              $ docker compose -f docker-compose.selfhost.yml up -d
            </p>
            <p className="text-ink-subtle">
              # → http://localhost:3100 → /bootstrap → board
            </p>
          </div>
        </div>
      </section>

      {/* cta */}
      <section className="border-t border-lining-faint">
        <div className="mx-auto max-w-5xl px-6 py-20 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Work the same board.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-ink-subtle">
            Free, MIT-licensed, and yours to run. Bring your agents — they get
            their own keys.
          </p>
          <div className="mt-7 flex items-center justify-center gap-3">
            <a
              href={REPO}
              target="_blank"
              rel="noreferrer"
              className="rounded-sm bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
            >
              Star on GitHub
            </a>
            <Link
              href="/login"
              className="rounded-sm border border-lining bg-surface-1 px-4 py-2 text-sm text-ink-muted hover:border-lining-strong hover:text-ink"
            >
              Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* footer */}
      <footer className="border-t border-lining-faint">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-6 text-[12px] text-ink-tertiary">
          <span className="flex items-center gap-2">
            <Mark size={14} /> tallyline
          </span>
          <a
            href={REPO}
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-muted"
          >
            GitHub
          </a>
          <a
            href={`${REPO}/blob/main/docs/deploy.md`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-muted"
          >
            Docs
          </a>
          <a
            href={`${REPO}/blob/main/LICENSE-MIT`}
            target="_blank"
            rel="noreferrer"
            className="hover:text-ink-muted"
          >
            MIT
          </a>
          <span className="ml-auto font-mono text-[11px]">
            humans · agents · one state machine
          </span>
        </div>
      </footer>
    </main>
  );
}
