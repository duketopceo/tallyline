import { CliError } from "../cli-error.js";
import type { CliIo } from "../commands.js";
import { paths } from "./home.js";
import { realSys, type RunResult, type Sys } from "./sys.js";

// Shared by setup and the server commands: talking to compose, waiting for the
// server, and turning failures into plain words.

export const sysOf = (io: CliIo): Sys => io.sys ?? realSys;
export const napOf = (io: CliIo) => io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

export function compose(sys: Sys, dir: string, args: string[]): Promise<RunResult> {
  const p = paths(dir);
  return sys.run("docker", ["compose", "-p", "tallyline", "-f", p.compose, "--env-file", p.env, ...args], { cwd: dir });
}

/** the last few lines of a failure, with nothing that looks like a secret assignment */
export function tail(r: RunResult, lines = 6): string {
  return (r.stderr || r.stdout)
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/(PASSWORD|SECRET|TOKEN|KEY)=/i.test(l))
    .slice(-lines)
    .join("\n");
}

export async function waitHealthy(io: CliIo, apiPort: number, onTick?: (n: number) => void): Promise<boolean> {
  const nap = napOf(io);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await io.fetch(new Request(`http://localhost:${apiPort}/health`));
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    onTick?.(i);
    await nap(3000);
  }
  return false;
}

export function needInstall<T>(state: T | undefined): T {
  if (!state) throw new CliError(1, "There is no Tallyline installed on this computer yet. Run: tallyline setup");
  return state;
}

export const homeLabel = (dir: string, env: Record<string, string | undefined>) =>
  env.HOME && dir.startsWith(`${env.HOME}/`) ? `~${dir.slice(env.HOME.length)}` : dir;
