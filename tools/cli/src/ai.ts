import type { AiProviderView } from "./client.js";
import { CliError } from "./cli-error.js";
import type { CmdCtx, Command } from "./commands.js";

// S3-U3: `tallyline ai …` connects the workspace's own AI provider from a
// terminal. Keys are never taken from argv (they would land in shell history
// and `ps`): OpenRouter hands one to the server directly through PKCE, and a
// compatible endpoint's key comes from a hidden prompt or stdin.

const SUBCOMMANDS = ["status", "connect", "test", "disconnect"] as const;

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function str(ctx: CmdCtx, name: string): string | undefined {
  const v = ctx.flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const last = v.at(-1);
    return typeof last === "string" ? last : undefined;
  }
  return undefined;
}

function capFlag(ctx: CmdCtx): number | undefined {
  const raw = str(ctx, "cap");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 10_000) {
    throw new CliError(2, "--cap is a monthly limit in dollars, between 0 and 10000");
  }
  return Math.round(n * 100);
}

function describe(p: AiProviderView | null): string[] {
  if (!p) return ["no AI provider; AI features are off", "connect one: tallyline ai connect openrouter"];
  const lines = [
    `provider: ${p.label}${p.source === "environment" ? " (set by the server)" : ""}`,
    `model:    ${p.model}`,
  ];
  if (p.baseUrl) lines.push(`endpoint: ${p.baseUrl}`);
  lines.push(`key:      ${p.hasKey ? "stored, sealed" : "none"}`);
  return lines;
}

async function readLine(ctx: CmdCtx, message: string, secret: boolean): Promise<string> {
  const p = ctx.io.prompter;
  if (p) {
    const v = secret
      ? await p.secret({ message, validate: (s) => (s.trim() ? undefined : "required") })
      : await p.text({ message, validate: (s) => (s.trim() ? undefined : "required") });
    return v.trim();
  }
  if (ctx.io.stdin) return ((await ctx.io.stdin()).split(/\r?\n/)[0] ?? "").trim();
  return "";
}

async function connectOpenRouter(ctx: CmdCtx): Promise<void> {
  const cap = capFlag(ctx);
  const model = str(ctx, "model");
  const start = await ctx.client.startOpenRouterConnect({
    mode: "headless",
    ...(model ? { model } : {}),
    ...(cap !== undefined ? { monthlyCapCents: cap } : {}),
  });
  // stderr for instructions so stdout stays the machine-readable result
  ctx.io.err("Open this page, sign in to OpenRouter and approve:");
  ctx.io.err(`  ${start.authUrl}`);
  ctx.io.err("OpenRouter then shows a code. Paste it here (it works once, for 10 minutes).");
  if (ctx.io.openUrl && ctx.io.isTTY) await ctx.io.openUrl(start.authUrl).catch(() => false);
  const code = await readLine(ctx, "Code from OpenRouter", false);
  if (!code) throw new CliError(2, "no code given; run `tallyline ai connect openrouter` again");
  const done = await ctx.client.completeOpenRouterConnect({ code, state: start.state });
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ connected: true, provider: done.provider }));
    return;
  }
  ctx.io.out("OpenRouter connected. The key is stored sealed on the server; it is never shown.");
  for (const l of describe(done.provider)) ctx.io.out(l);
}

async function connectCompatible(ctx: CmdCtx): Promise<void> {
  const baseUrl = str(ctx, "base-url");
  const model = str(ctx, "model");
  if (!baseUrl || !model) {
    throw new CliError(2, "compatible needs --base-url <https://…/v1> and --model <name>");
  }
  const cap = capFlag(ctx);
  const noKey = ctx.flags["no-key"] === true;
  const apiKey = noKey ? "" : await readLine(ctx, "API key (hidden; Enter for none)", true);
  const saved = await ctx.client.putAiProvider({
    kind: "openai_compatible",
    label: str(ctx, "label") ?? "OpenAI-compatible",
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(cap !== undefined ? { monthlyCapCents: cap } : {}),
  });
  if (ctx.json) {
    ctx.io.out(JSON.stringify({ connected: true, provider: saved }));
    return;
  }
  ctx.io.out("Endpoint saved. Check it with: tallyline ai test");
  for (const l of describe(saved)) ctx.io.out(l);
}

export const aiCmd: Command = {
  usage:
    "tallyline ai status | test | disconnect | connect openrouter [--model m] [--cap dollars] | " +
    "connect compatible --base-url url --model m [--label name] [--cap dollars] [--no-key]  " +
    "(the key is read from a hidden prompt or stdin, never from arguments)",
  summary: "connect, check or remove the workspace's AI provider (admin)",
  options: {
    model: { type: "string" },
    cap: { type: "string" },
    "base-url": { type: "string" },
    label: { type: "string" },
    "no-key": { type: "boolean" },
  },
  needsApi: true,
  async run(ctx) {
    const sub = ctx.args[0] ?? "status";
    if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
      throw new CliError(2, `unknown ai command '${sub}'; use one of: ${SUBCOMMANDS.join(", ")}`);
    }
    if (sub === "status") {
      const s = await ctx.client.aiProvider();
      if (ctx.json) {
        ctx.io.out(JSON.stringify(s));
        return;
      }
      for (const l of describe(s.provider)) ctx.io.out(l);
      if (s.provider) {
        const cap = s.provider.monthlyCapCents;
        ctx.io.out(
          `month:    ${dollars(s.usage.spentCents)}${cap === null ? " (no limit)" : ` of ${dollars(cap)}`}, ${s.usage.calls} calls`,
        );
      }
      return;
    }
    if (sub === "test") {
      const r = await ctx.client.testAiProvider();
      if (ctx.json) ctx.io.out(JSON.stringify(r));
      else if (r.ok) ctx.io.out(`ok: ${r.model ?? "provider"} answered in ${r.ms} ms`);
      else ctx.io.out(`failed: ${r.message ?? r.code ?? "no answer"}`);
      if (!r.ok) throw new CliError(1, "the provider test failed");
      return;
    }
    if (sub === "disconnect") {
      await ctx.client.deleteAiProvider();
      if (ctx.json) ctx.io.out(JSON.stringify({ disconnected: true }));
      else ctx.io.out("AI provider disconnected; the stored key is deleted.");
      return;
    }
    const kind = ctx.args[1];
    if (kind === "openrouter") return connectOpenRouter(ctx);
    if (kind === "compatible") return connectCompatible(ctx);
    throw new CliError(2, "connect what? use: tallyline ai connect openrouter | compatible");
  },
};
