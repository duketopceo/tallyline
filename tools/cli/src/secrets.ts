import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import type { EnvLike } from "./config.js";

// Where a sign-in token lives. Tokens never go on a command line (visible in
// `ps`) and never into config.json: the OS keychain when one exists, otherwise a
// private file (mode 0600) that `doctor` warns about.

export interface TokenStore {
  readonly kind: "macos-keychain" | "libsecret" | "file";
  get(server: string): Promise<string | undefined>;
  set(server: string, token: string): Promise<void>;
  remove(server: string): Promise<void>;
}

export type Runner = (
  cmd: string,
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

export const nodeRunner: Runner = (cmd, args, stdin) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { timeout: 8000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 127
              : 0;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
    else child.stdin?.end();
  });

const SERVICE = "tallyline";

function norm(server: string): string {
  return server.replace(/\/+$/, "");
}

// `security -i` reads its commands from stdin, so the token is never an argv.
class MacKeychain implements TokenStore {
  readonly kind = "macos-keychain" as const;
  constructor(private readonly run: Runner) {}
  async get(server: string) {
    const r = await this.run("security", [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      norm(server),
      "-w",
    ]);
    const v = r.stdout.trim();
    return r.code === 0 && v ? v : undefined;
  }
  async set(server: string, token: string) {
    const q = (s: string) => `"${s.replace(/["\\\n]/g, "")}"`;
    const cmd = `add-generic-password -U -s ${q(SERVICE)} -a ${q(norm(server))} -w ${q(token)}\n`;
    const r = await this.run("security", ["-i"], cmd);
    if (r.code !== 0) throw new Error("the macOS keychain refused the token");
  }
  async remove(server: string) {
    await this.run("security", [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      norm(server),
    ]);
  }
}

class LibSecret implements TokenStore {
  readonly kind = "libsecret" as const;
  constructor(private readonly run: Runner) {}
  async get(server: string) {
    const r = await this.run("secret-tool", [
      "lookup",
      "service",
      SERVICE,
      "server",
      norm(server),
    ]);
    const v = r.stdout.trim();
    return r.code === 0 && v ? v : undefined;
  }
  async set(server: string, token: string) {
    const r = await this.run(
      "secret-tool",
      ["store", "--label", "Tallyline", "service", SERVICE, "server", norm(server)],
      token,
    );
    if (r.code !== 0) throw new Error("the system keyring refused the token");
  }
  async remove(server: string) {
    await this.run("secret-tool", [
      "clear",
      "service",
      SERVICE,
      "server",
      norm(server),
    ]);
  }
}

export class FileStore implements TokenStore {
  readonly kind = "file" as const;
  constructor(readonly path: string) {}
  private async read(): Promise<Record<string, string>> {
    try {
      const v: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return typeof v === "object" && v !== null
        ? (v as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }
  private async write(all: Record<string, string>) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeFile(this.path, JSON.stringify(all, null, 2), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
  async get(server: string) {
    return (await this.read())[norm(server)] || undefined;
  }
  async set(server: string, token: string) {
    const all = await this.read();
    all[norm(server)] = token;
    await this.write(all);
  }
  async remove(server: string) {
    const all = await this.read();
    delete all[norm(server)];
    await this.write(all);
  }
}

export function credentialsPath(env: EnvLike): string {
  return join(env.HOME ?? homedir(), ".config", "tallyline", "credentials.json");
}

export async function openTokenStore(
  env: EnvLike,
  run: Runner = nodeRunner,
  os: string = platform(),
): Promise<TokenStore> {
  // an explicit opt-out for CI and tests
  if (env.TALLYLINE_KEYCHAIN === "off") return new FileStore(credentialsPath(env));
  if (os === "darwin") {
    const r = await run("security", ["help"]).catch(() => ({ code: 127, stdout: "" }));
    // `security help` exits non-zero on some versions but still exists; only
    // 127 (not found) rules the keychain out
    if (r.code !== 127) return new MacKeychain(run);
  }
  if (os === "linux") {
    const r = await run("secret-tool", ["--version"]).catch(() => ({ code: 127, stdout: "" }));
    if (r.code !== 127) return new LibSecret(run);
  }
  return new FileStore(credentialsPath(env));
}

/** Opens the store on first use, so commands that never need a token never probe the keychain. */
export function lazyTokenStore(env: EnvLike): TokenStore & { open(): Promise<TokenStore> } {
  let opened: Promise<TokenStore> | undefined;
  const open = () => (opened ??= openTokenStore(env));
  return {
    get kind() {
      return "file" as const; // real kind comes from open()
    },
    open,
    get: async (s) => (await open()).get(s),
    set: async (s, t) => (await open()).set(s, t),
    remove: async (s) => (await open()).remove(s),
  };
}
