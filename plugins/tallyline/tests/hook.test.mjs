import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  resolveIssueKey,
  sessionStart,
  stop,
} from "../hooks/tallyline-hook.mjs";

const SCRIPT = fileURLToPath(new URL("../hooks/tallyline-hook.mjs", import.meta.url));
const ENV = {
  TALLYLINE_TOKEN: "tly_agt_test",
  TALLYLINE_WORKSPACE: "acme",
  TALLYLINE_API_URL: "http://api.test",
  HOME: "/nonexistent-home",
};

function tmp() {
  return mkdtempSync(join(tmpdir(), "tly-hook-"));
}

/** Fake fetch: records calls, serves an issue in `state` and an agent identity. */
function fakeApi({ state = "backlog", assigneeId = null, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (fail) throw new Error("ECONNREFUSED");
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith("/v1/whoami")) return json({ type: "agent", id: "agt-1", name: "bot" });
    if (method === "GET") return json({ key: "KP-12", title: "Do it", state, assigneeId });
    return json({});
  };
  return { calls, fetchImpl };
}

function execFor({ branch, sha = "a".repeat(40), pr = "" }) {
  return async (cmd, args) => {
    if (cmd === "gh") return pr;
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return branch;
    if (args[0] === "rev-parse") return sha;
    return "fix the thing";
  };
}

test("resolveIssueKey: env wins, then branch, else null", () => {
  assert.equal(resolveIssueKey({ TALLYLINE_ISSUE: "kp-3" }, "feat/other-9"), "KP-3");
  assert.equal(resolveIssueKey({}, "feat/kp-12-add-widget"), "KP-12");
  assert.equal(resolveIssueKey({}, "KP-7"), "KP-7");
  assert.equal(resolveIssueKey({}, "main"), null);
  assert.equal(resolveIssueKey({}, "feat/agent-plugins-hooks"), null);
  assert.equal(resolveIssueKey({}, "release/ios-v1.1.0"), null);
  assert.equal(resolveIssueKey({ TALLYLINE_ISSUE: "nonsense" }, "kp-1"), null);
});

test("loadConfig: null without token or workspace; env overrides files", () => {
  const cwd = tmp();
  assert.equal(loadConfig({ HOME: "/nonexistent-home" }, cwd), null);
  writeFileSync(
    join(cwd, ".tallyline.json"),
    JSON.stringify({ token: "file-token", workspace: "filews", apiUrl: "http://file/" }),
  );
  assert.deepEqual(loadConfig({ HOME: "/nonexistent-home" }, cwd), {
    apiUrl: "http://file",
    token: "file-token",
    workspace: "filews",
  });
  assert.equal(
    loadConfig({ HOME: "/nonexistent-home", TALLYLINE_TOKEN: "env-token" }, cwd).token,
    "env-token",
  );
});

test("session start claims a backlog ticket (assign + hop to in_progress)", async () => {
  const { calls, fetchImpl } = fakeApi({ state: "backlog" });
  const out = await sessionStart({
    env: ENV,
    cwd: tmp(),
    input: { session_id: "s1" },
    stateDir: tmp(),
    fetchImpl,
    exec: execFor({ branch: "feat/kp-12-widget" }),
  });
  assert.match(out, /claimed KP-12/);
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.map((p) => p.body), [
    { assigneeType: "agent", assigneeId: "agt-1", state: "todo" },
    { state: "in_progress" },
  ]);
  assert.ok(calls.every((c) => c.url.startsWith("http://api.test/v1/")));
});

test("session start does not steal a ticket assigned to someone else", async () => {
  const { calls, fetchImpl } = fakeApi({ state: "todo", assigneeId: "human-9" });
  const out = await sessionStart({
    env: ENV,
    cwd: tmp(),
    input: {},
    stateDir: tmp(),
    fetchImpl,
    exec: execFor({ branch: "kp-12" }),
  });
  assert.match(out, /not claimed/);
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 0);
});

test("session start is a no-op without a ticket id (no network)", async () => {
  const { calls, fetchImpl } = fakeApi();
  const out = await sessionStart({
    env: ENV,
    cwd: tmp(),
    input: {},
    stateDir: tmp(),
    fetchImpl,
    exec: execFor({ branch: "main" }),
  });
  assert.equal(out, "");
  assert.equal(calls.length, 0);
});

test("session start fails soft: missing token, unreachable API", async () => {
  const noToken = await sessionStart({
    env: { HOME: "/nonexistent-home" },
    cwd: tmp(),
    input: {},
    stateDir: tmp(),
    fetchImpl: async () => assert.fail("must not call the network"),
    exec: execFor({ branch: "kp-12" }),
  });
  assert.equal(noToken, "");
  const { fetchImpl } = fakeApi({ fail: true });
  const down = await sessionStart({
    env: ENV,
    cwd: tmp(),
    input: {},
    stateDir: tmp(),
    fetchImpl,
    exec: execFor({ branch: "kp-12" }),
  });
  assert.equal(down, "");
});

test("stop: comments the commit, links the PR, moves in_progress to in_review, once", async () => {
  const stateDir = tmp();
  const startSha = "b".repeat(40);
  await sessionStart({
    env: ENV,
    cwd: tmp(),
    input: { session_id: "s2" },
    stateDir,
    fetchImpl: fakeApi({ state: "in_progress" }).fetchImpl,
    exec: execFor({ branch: "kp-12", sha: startSha }),
  });

  const api = fakeApi({ state: "in_progress" });
  const deps = {
    env: ENV,
    cwd: tmp(),
    input: { session_id: "s2" },
    stateDir,
    fetchImpl: api.fetchImpl,
    exec: execFor({
      branch: "kp-12",
      sha: "c".repeat(40),
      pr: "https://github.com/acme/repo/pull/5",
    }),
  };
  assert.equal(await stop(deps), "updated:in_review");
  const comment = api.calls.find((c) => c.method === "POST");
  assert.match(comment.body.body, /commit cccccccc/);
  assert.match(comment.body.body, /pull\/5/);
  assert.deepEqual(api.calls.find((c) => c.method === "PATCH").body, { state: "in_review" });

  // Stop fires every turn: a second identical stop must do nothing.
  const again = fakeApi({ state: "in_review" });
  assert.equal(await stop({ ...deps, fetchImpl: again.fetchImpl }), "noop:already-reported");
  assert.equal(again.calls.length, 0);
});

test("stop: comment only (no status change) when there is a commit but no PR", async () => {
  const api = fakeApi({ state: "in_progress" });
  const out = await stop({
    env: ENV,
    cwd: tmp(),
    input: { session_id: "s3" },
    stateDir: tmp(),
    fetchImpl: api.fetchImpl,
    exec: execFor({ branch: "kp-12" }),
  });
  assert.equal(out, "updated:comment");
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("stop: no-ops when HEAD did not move since session start", async () => {
  const stateDir = tmp();
  const sha = "d".repeat(40);
  await sessionStart({
    env: { HOME: "/nonexistent-home" },
    cwd: tmp(),
    input: { session_id: "s4" },
    stateDir,
    fetchImpl: async () => assert.fail("no network"),
    exec: execFor({ branch: "kp-12", sha }),
  });
  const api = fakeApi();
  const out = await stop({
    env: ENV,
    cwd: tmp(),
    input: { session_id: "s4" },
    stateDir,
    fetchImpl: api.fetchImpl,
    exec: execFor({ branch: "kp-12", sha }),
  });
  assert.equal(out, "noop:no-new-commit");
  assert.equal(api.calls.length, 0);
});

test("stop: no-ops without a ticket, without config, and on API failure", async () => {
  const base = { cwd: tmp(), input: { session_id: "s5" }, stateDir: tmp() };
  assert.equal(
    await stop({ ...base, env: ENV, fetchImpl: fakeApi().fetchImpl, exec: execFor({ branch: "main" }) }),
    "noop:no-ticket",
  );
  assert.equal(
    await stop({
      ...base,
      env: { HOME: "/nonexistent-home" },
      fetchImpl: fakeApi().fetchImpl,
      exec: execFor({ branch: "kp-12" }),
    }),
    "noop:no-config",
  );
  assert.equal(
    await stop({ ...base, env: ENV, fetchImpl: fakeApi({ fail: true }).fetchImpl, exec: execFor({ branch: "kp-12" }) }),
    "noop:api-error",
  );
});

test("CLI entrypoint always exits 0 and prints nothing without a ticket or token", () => {
  const cwd = tmp();
  mkdirSync(join(cwd, "empty"));
  for (const sub of ["session-start", "stop", "bogus"]) {
    const r = spawnSync(process.execPath, [SCRIPT, sub], {
      input: "not json",
      cwd: join(cwd, "empty"),
      env: { PATH: process.env.PATH, HOME: "/nonexistent-home" },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, sub);
    assert.equal(r.stdout, "", sub);
  }
});

test("CLI entrypoint exits 0 when the API is unreachable", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "session-start"], {
    input: JSON.stringify({ cwd: tmp(), session_id: "x" }),
    env: {
      PATH: process.env.PATH,
      HOME: "/nonexistent-home",
      TALLYLINE_ISSUE: "KP-1",
      TALLYLINE_TOKEN: "t",
      TALLYLINE_WORKSPACE: "w",
      TALLYLINE_API_URL: "http://127.0.0.1:1",
    },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
