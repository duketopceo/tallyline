#!/usr/bin/env node
import { run } from "./cli.js";

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

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
  fetch: (request) => fetch(request),
  stdin: readStdin,
  isTTY: process.stdout.isTTY === true,
});
process.exitCode = code;
