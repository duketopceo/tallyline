import { chmod, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../cli-error.js";
import type { Command } from "../commands.js";
import { VERSION } from "../version.js";
import { bold } from "../pretty.js";
import { statusLine } from "../ui/render.js";
import { installDir, paths, readEnvFile, readState, serializeEnv, writePrivate, writeState, type InstallState } from "../setup/home.js";
import { secretsScreen } from "../setup/setup.js";
import { compose, homeLabel, needInstall, sysOf, tail, waitHealthy } from "../setup/run.js";
import type { CliIo } from "../commands.js";
import type { Sys } from "../setup/sys.js";

// Day-to-day care of the Tallyline that `setup` installed: start, stop, backup,
// update. Thin, guided wrappers over compose. None of them delete data.

const dirFlag = { dir: { type: "string" as const } };
const KEEP_BACKUPS = 7;

async function load(io: CliIo, flags: Record<string, unknown>) {
  const dir = installDir(io.env, typeof flags.dir === "string" ? flags.dir : undefined);
  const state: InstallState = needInstall(await readState(dir));
  return { dir, state, sys: sysOf(io), home: homeLabel(dir, io.env) };
}

async function needDocker(sys: Sys): Promise<void> {
  const r = await sys.run("docker", ["info"]);
  if (r.code !== 0) throw new CliError(1, "Docker isn't running. Open Docker Desktop (or start the Docker service), then try again.");
}

export const resumeCmd: Command = {
  usage: "tallyline resume [--dir PATH]",
  summary: "start your Tallyline again after a stop",
  options: dirFlag,
  needsApi: false,
  run: async ({ io, flags }) => {
    const { dir, state, sys } = await load(io, flags);
    await needDocker(sys);
    const r = await compose(sys, dir, ["up", "-d"]);
    if (r.code !== 0) throw new CliError(1, `${tail(r)}\n\nTry tallyline doctor.`);
    const ok = await waitHealthy(io, state.apiPort);
    if (!ok) throw new CliError(1, "Started, but it isn't answering yet. Give it a minute and run: tallyline resume");
    io.out(statusLine("ok", `Tallyline is running at http://localhost:${state.webPort}`));
  },
};

export const stopCmd: Command = {
  usage: "tallyline stop [--dir PATH]",
  summary: "pause your Tallyline (your data stays)",
  options: dirFlag,
  needsApi: false,
  run: async ({ io, flags }) => {
    const { dir, sys } = await load(io, flags);
    await needDocker(sys);
    // `stop`, never `down`: containers pause, and nothing is removed.
    const r = await compose(sys, dir, ["stop"]);
    if (r.code !== 0) throw new CliError(1, tail(r));
    io.out(statusLine("ok", "Tallyline is paused. Your data is safe. Run tallyline resume to bring it back."));
  },
};

/** one local backup: a database dump in ~/.tallyline/backups, 0600, newest 7 kept */
export async function runBackup(dir: string, sys: Sys): Promise<string> {
  const p = paths(dir);
  const stamp = new Date(sys.now()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const name = `tallyline-${stamp}.dump`;
  const inside = `/tmp/${name}`;
  const dump = await compose(sys, dir, ["exec", "-T", "postgres", "sh", "-c", `pg_dump -U postgres -Fc tallyline > ${inside}`]);
  if (dump.code !== 0) throw new CliError(1, `The backup did not work. Is Tallyline running? (tallyline resume)\n${tail(dump)}`);
  const out = join(p.backups, name);
  const cp = await compose(sys, dir, ["cp", `postgres:${inside}`, out]);
  await compose(sys, dir, ["exec", "-T", "postgres", "rm", "-f", inside]);
  if (cp.code !== 0) throw new CliError(1, `The backup was made but could not be copied out.\n${tail(cp)}`);
  await chmod(out, 0o600);
  const now = new Date(sys.now());
  await writeFile(p.marker, "");
  await utimes(p.marker, now, now); // the status page reads this file's age
  const old = (await readdir(p.backups)).filter((f) => f.endsWith(".dump")).sort().slice(0, -KEEP_BACKUPS);
  for (const f of old) await rm(join(p.backups, f), { force: true });
  return out;
}

export const backupCmd: Command = {
  usage: "tallyline backup [--dir PATH]",
  summary: "save a copy of your data now",
  options: dirFlag,
  needsApi: false,
  run: async ({ io, flags }) => {
    const { dir, sys, home } = await load(io, flags);
    await needDocker(sys);
    const sp = io.prompter?.spin("Backing up");
    const out = await runBackup(dir, sys);
    sp?.succeed("Backup saved");
    io.out(
      [
        statusLine("ok", `Saved ${homeLabel(out, io.env)}`),
        `  Keeps the newest ${KEEP_BACKUPS} here. It is only as safe as this computer: copy it somewhere else too.`,
        `  To restore it you also need your keys (${home}/.env).`,
      ].join("\n"),
    );
    const state = await readState(dir);
    if (state && !state.secretsSavedAt && io.prompter) {
      if ((await secretsScreen(io.prompter, dir, home, io.env.HOME)) === "saved") {
        await writeState(dir, { ...state, secretsSavedAt: new Date(sys.now()).toISOString() });
      }
    } else if (state && !state.secretsSavedAt) {
      io.out(statusLine("warn", `Your keys are not recorded as saved. Copy ${home}/.env somewhere safe.`));
    }
  },
};

export const updateCmd: Command = {
  usage: "tallyline update [--to VERSION] [--yes] [--dir PATH]",
  summary: "update your Tallyline to the version this tool matches",
  options: { ...dirFlag, to: { type: "string" }, yes: { type: "boolean", short: "y" } },
  needsApi: false,
  run: async ({ io, flags }) => {
    const { dir, state, sys, home } = await load(io, flags);
    await needDocker(sys);
    const target = typeof flags.to === "string" ? flags.to.replace(/^v/, "") : VERSION;
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(target)) throw new CliError(2, "--to needs a version like 2.1.0");
    if (target === state.version) {
      io.out(statusLine("ok", `Already on version ${target}.`));
      return;
    }
    if (io.prompter && flags.yes !== true && !(await io.prompter.confirm({ message: `Update from ${state.version} to ${target}? Tallyline backs up first and goes back if it fails.`, initial: true }))) {
      return;
    }
    io.out(statusLine("info", "Saving a backup first"));
    const backup = await runBackup(dir, sys);

    const p = paths(dir);
    const before = await readEnvFile(dir);
    const setTag = async (tag: string) => writePrivate(p.env, serializeEnv({ ...before, TALLYLINE_IMAGE_TAG: tag }));
    const goBack = async (why: string): Promise<never> => {
      await setTag(state.version);
      const r = await compose(sys, dir, ["up", "-d"]);
      const back = r.code === 0 && (await waitHealthy(io, state.apiPort));
      throw new CliError(
        1,
        `${why}\n${back ? `Went back to version ${state.version}. If the new version had already changed your data, restore the backup below.` : `Could not confirm the old version came back. Run tallyline doctor.`}\nYour backup: ${homeLabel(backup, io.env)}`,
      );
    };

    await setTag(target);
    const pull = await compose(sys, dir, ["pull"]);
    if (pull.code !== 0) return goBack(`Couldn't download version ${target}. ${tail(pull)}`);
    const up = await compose(sys, dir, ["up", "-d"]);
    if (up.code !== 0) return goBack(`Version ${target} didn't start. ${tail(up)}`);
    if (!(await waitHealthy(io, state.apiPort))) return goBack(`Version ${target} started but never became healthy.`);

    await writeState(dir, { ...state, version: target, previousVersion: state.version });
    io.out(`${statusLine("ok", `Updated to version ${bold(target)}`)}\n  Backup from before the update: ${homeLabel(backup, io.env)}  (${home})`);
  },
};
