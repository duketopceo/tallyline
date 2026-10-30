import { stat } from "node:fs/promises";
import { CliError } from "../cli-error.js";
import type { Command, CmdCtx } from "../commands.js";
import { VERSION } from "../version.js";
import type { Prompter } from "../ui/prompt.js";
import { bold, dim } from "../pretty.js";
import { nextSteps, section, statusLine } from "../ui/render.js";
import { DEFAULT_API_PORT, DEFAULT_WEB_PORT, ensureInstall, installDir, paths, readEnvFile, readState, SECRET_KEYS, writePrivate, writeState } from "./home.js";
import { dockerState, preflight } from "./preflight.js";
import { compose, homeLabel, napOf, sysOf, tail, waitHealthy } from "./run.js";
import type { Sys } from "./sys.js";

// `tallyline setup`: from nothing to a running Tallyline on this computer.
// Re-runnable: an existing install gets repair or upgrade, never a reinstall.
// Nothing is installed without asking, and no volume is ever deleted here.

const DOCKER_LINK = "https://docs.docker.com/get-docker/";

function portFlag(v: unknown, dflt: number, name: string): number {
  if (typeof v !== "string") return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new CliError(2, `${name} must be a number between 1024 and 65535`);
  return n;
}

async function ensureDocker(ctx: CmdCtx, sys: Sys): Promise<void> {
  const { io } = ctx;
  const p = io.prompter;
  let state = await dockerState(sys);
  if (state === "ready") return;

  if (state === "missing") {
    const brew = sys.platform === "darwin" ? (await sys.run("brew", ["--version"])).code === 0 : false;
    if (brew && p && (await p.confirm({ message: "Tallyline runs inside Docker, which isn't installed. Install Docker Desktop with Homebrew now?", initial: true }))) {
      const sp = p.spin("Installing Docker Desktop (this can take a few minutes)");
      const r = await sys.run("brew", ["install", "--cask", "docker"]);
      if (r.code !== 0) {
        sp.fail("The Docker install did not finish");
        throw new CliError(1, `${tail(r)}\n\nYou can also install it yourself: ${DOCKER_LINK}`);
      }
      sp.succeed("Docker Desktop installed");
      p.note("Open Docker from your Applications folder once and accept its terms.\nWhen its whale icon stops animating, run: tallyline setup", "One step left");
      throw new CliError(1, "");
    }
    throw new CliError(
      1,
      sys.platform === "darwin"
        ? `Tallyline runs inside Docker, which isn't installed.\nInstall Docker Desktop from ${DOCKER_LINK}, open it once, then run: tallyline setup`
        : `Tallyline runs inside Docker, which isn't installed.\nFollow the steps for your system at https://docs.docker.com/engine/install/ , then run: tallyline setup`,
    );
  }

  // installed but not running
  if (sys.platform === "darwin" && p && (await p.confirm({ message: "Docker isn't running. Start Docker Desktop for you?", initial: true }))) {
    await sys.run("open", ["-a", "Docker"]);
    const sp = p.spin("Waiting for Docker to wake up");
    for (let i = 0; i < 45 && state !== "ready"; i++) {
      await napOf(io)(2000);
      state = await dockerState(sys);
    }
    if (state === "ready") return void sp.succeed("Docker is running");
    sp.fail("Docker is taking a while");
  }
  throw new CliError(
    1,
    sys.platform === "darwin"
      ? "Docker isn't running yet. Open Docker Desktop, wait until it says it is running, then run: tallyline setup"
      : "Docker isn't running. Start it (usually: sudo systemctl start docker), then run: tallyline setup",
  );
}

/** the one screen that cannot be skipped: where the secrets live, and why they matter */
export async function secretsScreen(p: Prompter, dir: string, home: string, userHome: string | undefined): Promise<"saved" | "later"> {
  p.note(
    [
      "Your server's keys are in this file:",
      `  ${home}/.env`,
      "",
      "If this computer is lost or wiped, a backup is useless without them,",
      "and any sign-in settings you save in Tallyline cannot be read again.",
      "Keep a copy somewhere safe, like a password manager.",
    ].join("\n"),
    "Keep your keys safe",
  );
  for (;;) {
    const choice = await p.select<"show" | "file" | "done" | "later">({
      message: "How would you like to keep a copy?",
      options: [
        { value: "show", label: "Show them here so I can copy them" },
        { value: "file", label: "Save a copy to a file I choose" },
        { value: "done", label: "I have already copied that file somewhere safe" },
        { value: "later", label: "Ask me later", hint: "Tallyline will keep reminding you" },
      ],
    });
    if (choice === "later") return "later";
    if (choice === "done") return "saved";
    const env = await readEnvFile(dir);
    const secrets = SECRET_KEYS.map((k) => `${k}=${env[k] ?? ""}`).join("\n");
    if (choice === "show") {
      p.note(secrets, "Your keys (copy these now)");
      if (await p.confirm({ message: "Have you saved them?", initial: false })) return "saved";
    } else {
      const to = await p.text({ message: "Where should the copy go?", placeholder: "~/Documents/tallyline-keys.txt", validate: (v) => (v.trim() ? undefined : "Type a file path") });
      const target = to.trim().replace(/^~(?=\/)/, userHome ?? "~");
      try {
        if (await stat(target).then(() => true, () => false)) {
          p.step("fail", "That file already exists. Pick a new file name so nothing is overwritten.");
          continue;
        }
        await writePrivate(target, `${secrets}\n`);
        p.step("ok", `Saved to ${to.trim()} (only you can read it)`);
        return "saved";
      } catch (err) {
        p.step("fail", `Couldn't write there: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

export const setupCmd: Command = {
  usage: "tallyline setup [--port N] [--api-port N] [--dir PATH] [--yes] [--no-open]",
  summary: "set up your own Tallyline on this computer",
  options: {
    port: { type: "string" },
    "api-port": { type: "string" },
    dir: { type: "string" },
    yes: { type: "boolean", short: "y" },
    "no-open": { type: "boolean" },
  },
  needsApi: false,
  run: async (ctx) => {
    const { io, flags } = ctx;
    const sys = sysOf(io);
    const p = io.prompter;
    const dir = installDir(io.env, typeof flags.dir === "string" ? flags.dir : undefined);
    const home = homeLabel(dir, io.env);
    const existing = await readState(dir);
    const webPort = portFlag(flags.port, existing?.webPort ?? DEFAULT_WEB_PORT, "--port");
    const apiPort = portFlag(flags["api-port"], existing?.apiPort ?? DEFAULT_API_PORT, "--api-port");
    if (!p && flags.yes !== true) throw new CliError(2, "setup asks questions, so it needs a terminal. In a script, add --yes to accept the defaults.");

    p?.intro("Let's set up your Tallyline");

    if (existing) {
      const act = p
        ? await p.select<"repair" | "update" | "stop">({
            message: `Tallyline is already set up in ${home}. What would you like to do?`,
            options: [
              { value: "repair", label: "Check it and start anything that stopped", hint: "keeps all your data" },
              { value: "update", label: `Update to version ${VERSION}` },
              { value: "stop", label: "Nothing, leave it as it is" },
            ],
            initial: "repair",
          })
        : "repair";
      if (act === "stop") return void p?.outro("Left as it was.");
      if (act === "update") {
        const { updateCmd } = await import("../ops/ops.js");
        return updateCmd.run({ ...ctx, flags: { ...flags, yes: true }, args: [] });
      }
    }

    const pre = await preflight({ sys, dir, webPort, apiPort, portsOwned: existing !== undefined });
    for (const c of pre.checks) {
      if (c.id === "docker") continue; // handled with its own offer below
      const line = statusLine(c.level, c.message);
      if (p) p.step(c.level === "ok" ? "ok" : c.level === "warn" ? "warn" : "fail", c.message);
      else io.out(line);
      if (c.fix) io.out(`  ${c.fix}`);
    }
    if (!pre.ok) throw new CliError(1, "Setup stopped before changing anything. Fix the above and run: tallyline setup");

    await ensureDocker(ctx, sys);
    p?.step("ok", "Docker is ready");

    // Keys lost but the database kept: new keys would lock the old data out. Stop instead.
    if (!(await readEnvFile(dir)).POSTGRES_PASSWORD && (await sys.run("docker", ["volume", "inspect", "tallyline-postgres"])).code === 0) {
      throw new CliError(
        1,
        `Found an existing Tallyline database on this computer, but no keys in ${home}.\nStarting fresh keys would lock you out of it. Restore ${home}/.env from your saved copy, then run: tallyline setup\nIf you really want to start over, remove the Docker volume "tallyline-postgres" yourself first (this deletes that data).`,
      );
    }
    const { created } = await ensureInstall({ dir, sys, version: VERSION, webPort, apiPort });
    p?.step("ok", created ? `Created ${home} with fresh keys` : `Using the existing keys in ${home}`);

    const sp = p?.spin("Starting Tallyline (the first time it downloads about 1 GB)");
    const up = await compose(sys, dir, ["up", "-d"]);
    if (up.code !== 0) {
      sp?.fail("Tallyline did not start");
      throw new CliError(1, `${tail(up)}\n\nNothing was lost. Run tallyline setup again to retry, or tallyline doctor for help.`);
    }
    sp?.update("Waiting for Tallyline to be ready");
    const healthy = await waitHealthy(io, apiPort);
    if (!healthy) {
      sp?.fail("Tallyline started but isn't answering yet");
      throw new CliError(1, `It may just need another minute. Run tallyline setup again to keep waiting.\nTo see what it says: docker compose -p tallyline -f ${paths(dir).compose} logs api`);
    }
    sp?.succeed("Tallyline is running");

    let state = (await readState(dir))!;
    if (!state.secretsSavedAt && p) {
      if ((await secretsScreen(p, dir, home, io.env.HOME)) === "saved") {
        state = { ...state, secretsSavedAt: new Date(sys.now()).toISOString() };
        await writeState(dir, state);
      }
    }

    const address = `http://localhost:${webPort}`;
    const opened = flags["no-open"] !== true && io.openUrl ? await io.openUrl(`${address}/bootstrap`).catch(() => false) : false;
    const lines = [
      section("Your Tallyline is ready", [
        `Open   ${bold(`${address}/bootstrap`)}${opened ? dim("   (opening in your browser)") : ""}`,
        "Create your account there. You will be the first admin.",
      ]),
      "",
      nextSteps([
        ["tallyline connect", "sign this computer in, for the terminal and agents"],
        ["tallyline stop", "pause Tallyline"],
        ["tallyline backup", "save a copy of your data"],
      ]),
    ];
    if (!state.secretsSavedAt) lines.push("", `${statusLine("warn", `Your keys are not saved yet. Copy ${home}/.env somewhere safe, then run: tallyline backup`)}`);
    io.out(lines.join("\n"));
    p?.outro("All set.");
  },
};
