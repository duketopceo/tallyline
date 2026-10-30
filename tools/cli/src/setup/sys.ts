import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { statfs } from "node:fs/promises";
import { createServer } from "node:net";
import { totalmem } from "node:os";

// Everything `setup` and the server commands need from the computer, behind one
// seam. Tests pass a scripted `Sys`; the real one is `realSys`.

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sys {
  platform: string;
  totalMemBytes(): number;
  freeDiskBytes(path: string): Promise<number | undefined>;
  portFree(port: number): Promise<boolean>;
  /** runs a program without a shell; code 127 when the program does not exist */
  run(cmd: string, args: string[], opts?: { cwd?: string }): Promise<RunResult>;
  randomHex(bytes: number): string;
  randomBase64(bytes: number): string;
  now(): number;
}

export const realSys: Sys = {
  platform: process.platform,
  totalMemBytes: () => totalmem(),
  async freeDiskBytes(path) {
    try {
      const s = await statfs(path);
      return s.bavail * s.bsize;
    } catch {
      return undefined;
    }
  },
  portFree: (port) =>
    new Promise((resolve) => {
      const srv = createServer();
      srv.once("error", () => resolve(false));
      srv.once("listening", () => srv.close(() => resolve(true)));
      srv.listen(port);
    }),
  run: (cmd, args, opts) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { cwd: opts?.cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30 * 60_000 },
        (err, stdout, stderr) => {
          if (!err) return resolve({ code: 0, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          if (e.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: String(e.message) });
          resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: stderr || String(e.message) });
        },
      );
    }),
  randomHex: (n) => randomBytes(n).toString("hex"),
  randomBase64: (n) => randomBytes(n).toString("base64"),
  now: () => Date.now(),
};
