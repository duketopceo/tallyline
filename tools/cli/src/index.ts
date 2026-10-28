#!/usr/bin/env node
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { run } from "./cli.js";
import { lazyTokenStore } from "./secrets.js";
import { clackPrompter } from "./ui/prompt.js";

// Piped stdin feeds `comment`/`create` bodies; a TTY returns empty so
// commands fall back to argument/--body validation.
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

// Best effort: hands a web address to the system opener. No shell is involved, so the address
// is only ever an argument. Resolves false when there is no opener or it fails to start.
function openUrl(url: string): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return Promise.resolve(false);
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolve(false));
      child.on("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
  fetch: (request) => fetch(request),
  stdin: readStdin,
  isTTY: process.stdout.isTTY === true,
  tokens: lazyTokenStore(process.env),
  openUrl,
  hostname: hostname(),
  ...(process.stdout.isTTY === true && process.stdin.isTTY === true
    ? { prompter: clackPrompter }
    : {}),
});
process.exitCode = code;
