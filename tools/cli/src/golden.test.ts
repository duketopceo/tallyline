import { describe, expect, it } from "vitest";
import { run, VERSION } from "./cli.js";
import type { CliIo } from "./commands.js";

// Golden pins for the machine contract: anything that is not an interactive
// terminal must keep producing exactly this output, byte for byte. The pretty
// layer (UI kit, home screen, friendly errors) is only ever allowed on a TTY.

interface Capture {
  out: string[];
  err: string[];
  code: number;
}

function stubFetch(
  status: number,
  body: unknown,
): (req: Request) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}

async function exec(
  argv: string[],
  over: Partial<CliIo> = {},
): Promise<Capture> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: {},
    cwd: "/nonexistent-golden-cwd",
    fetch: stubFetch(200, {}),
    isTTY: false,
    ...over,
  };
  const code = await run(argv, io);
  return { out, err, code };
}

const AUTH_ENV = {
  HOME: "/nonexistent-golden-home",
  TALLYLINE_API_URL: "http://golden.test",
  TALLYLINE_TOKEN: "tly_pat_golden",
  TALLYLINE_WORKSPACE: "acme",
};

describe("non-TTY output is pinned", () => {
  it("no arguments prints banner and help on stderr, exit 2", async () => {
    expect(await exec([])).toMatchSnapshot();
  });
  it("help", async () => {
    expect(await exec(["help"])).toMatchSnapshot();
  });
  it("help <command>", async () => {
    expect(await exec(["help", "ready"])).toMatchSnapshot();
  });
  it("--version", async () => {
    const r = await exec(["--version"]);
    expect(r.out).toEqual([`✦ tallyline v${VERSION}`]);
    expect(r.code).toBe(0);
  });
  it("unknown command", async () => {
    expect(await exec(["frobnicate"])).toMatchSnapshot();
  });
  it("missing workspace and token", async () => {
    expect(
      await exec(["list"], { env: { HOME: "/nonexistent-golden-home" } }),
    ).toMatchSnapshot();
    expect(
      await exec(["list"], {
        env: { HOME: "/nonexistent-golden-home", TALLYLINE_WORKSPACE: "acme" },
      }),
    ).toMatchSnapshot();
  });
  it("API errors keep CODE: message and their exit code", async () => {
    const notFound = stubFetch(404, {
      error: { code: "NOT_FOUND", message: "issue not found" },
    });
    expect(
      await exec(["show", "ENG-1"], { env: AUTH_ENV, fetch: notFound }),
    ).toMatchSnapshot();
    const denied = stubFetch(401, {
      error: { code: "UNAUTHORIZED", message: "bad token" },
    });
    expect(
      await exec(["list"], { env: AUTH_ENV, fetch: denied }),
    ).toMatchSnapshot();
  });
  it("--json and text list output", async () => {
    const empty = stubFetch(200, { issues: [], nextCursor: null });
    expect(
      await exec(["list", "--json"], { env: AUTH_ENV, fetch: empty }),
    ).toMatchSnapshot();
    expect(
      await exec(["list"], { env: AUTH_ENV, fetch: empty }),
    ).toMatchSnapshot();
  });
});
