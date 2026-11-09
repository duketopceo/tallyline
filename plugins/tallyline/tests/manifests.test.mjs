import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(PLUGIN, "..", "..");
const read = (p) => JSON.parse(readFileSync(p, "utf8"));

const mcp = read(join(PLUGIN, ".mcp.json"));
const claude = read(join(PLUGIN, ".claude-plugin", "plugin.json"));

const VENDORS = {
  claude: join(PLUGIN, ".claude-plugin", "plugin.json"),
  codex: join(PLUGIN, ".codex-plugin", "plugin.json"),
  devin: join(PLUGIN, ".devin-plugin", "plugin.json"),
  cursor: join(PLUGIN, ".cursor-plugin", "plugin.json"),
  factory: join(PLUGIN, ".factory-plugin", "plugin.json"),
};

for (const [vendor, file] of Object.entries(VENDORS)) {
  test(`${vendor} manifest: required fields, MIT, one version`, () => {
    const m = read(file);
    assert.equal(m.name, "tallyline");
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
    assert.equal(m.version, claude.version, "all vendors ship the same version");
    assert.equal(m.license, "MIT");
    assert.ok(m.description?.length > 20);
    assert.equal(m.repository, "https://github.com/duketopceo/tallyline");
  });

  if (vendor !== "claude") {
    test(`${vendor} manifest points at the shared skills and .mcp.json, defines no tools`, () => {
      const m = read(file);
      assert.equal(m.skills, "./skills/");
      assert.ok(existsSync(join(PLUGIN, "skills", "tallyline", "SKILL.md")));
      assert.equal(m.mcpServers, "./.mcp.json", "single source of truth for the server");
      assert.ok(existsSync(join(PLUGIN, ".mcp.json")));
      for (const banned of ["tools", "commands", "hooks"]) {
        assert.equal(m[banned], undefined, `${vendor}: no duplicated ${banned}`);
      }
    });
  }
}

test("codex manifest carries the interface block Codex requires", () => {
  const { interface: ui } = read(VENDORS.codex);
  for (const k of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    assert.ok(typeof ui[k] === "string" && ui[k], k);
  }
  assert.ok(Array.isArray(ui.capabilities));
});

test(".mcp.json wraps the published MCP server and carries no secret values", () => {
  assert.deepEqual(Object.keys(mcp.mcpServers), ["tallyline"]);
  const s = mcp.mcpServers.tallyline;
  assert.equal(s.command, "npx");
  assert.deepEqual(s.args, ["-y", "@tallyline/mcp-server"]);
  for (const v of Object.values(s.env)) assert.match(v, /^\$\{user_config\.\w+\}$/);
});

test("gemini extension: schema fields, context file, server equals .mcp.json", () => {
  const g = read(join(ROOT, "gemini-extension.json"));
  assert.equal(g.name, "tallyline");
  assert.match(g.version, /^\d+\.\d+\.\d+$/);
  assert.equal(g.version, claude.version);
  assert.ok(existsSync(join(ROOT, g.contextFileName)));
  const shared = mcp.mcpServers.tallyline;
  assert.equal(g.mcpServers.tallyline.command, shared.command);
  assert.deepEqual(g.mcpServers.tallyline.args, shared.args);
  const vars = g.settings.map((s) => s.envVar).sort();
  assert.deepEqual(vars, ["TALLYLINE_API_URL", "TALLYLINE_TOKEN", "TALLYLINE_WORKSPACE"]);
  assert.equal(g.settings.find((s) => s.envVar === "TALLYLINE_TOKEN").sensitive, true);
});

test("codex-style .agents marketplace resolves to the plugin directory", () => {
  const m = read(join(ROOT, ".agents", "plugins", "marketplace.json"));
  assert.equal(m.plugins.length, 1);
  const p = m.plugins[0];
  assert.equal(p.name, "tallyline");
  assert.equal(p.source.source, "local");
  assert.ok(existsSync(join(ROOT, p.source.path, ".codex-plugin", "plugin.json")));
  assert.match(p.policy.installation, /^(AVAILABLE|INSTALLED_BY_DEFAULT|NOT_AVAILABLE)$/);
});

test("claude marketplace lists the plugin dir", () => {
  const m = read(join(ROOT, ".claude-plugin", "marketplace.json"));
  const p = m.plugins.find((x) => x.name === "tallyline");
  assert.ok(existsSync(join(ROOT, p.source, ".claude-plugin", "plugin.json")));
});

test("hooks.json: SessionStart and Stop run the script, which exists", () => {
  const h = read(join(PLUGIN, "hooks", "hooks.json"));
  for (const [event, arg] of [["SessionStart", "session-start"], ["Stop", "stop"]]) {
    const cmd = h.hooks[event][0].hooks[0];
    assert.equal(cmd.type, "command");
    assert.match(cmd.command, new RegExp(`tallyline-hook\\.mjs"? ${arg}$`));
    assert.ok(cmd.timeout > 0 && cmd.timeout <= 30, "bounded timeout");
  }
  assert.ok(existsSync(join(PLUGIN, "hooks", "tallyline-hook.mjs")));
});

test("no secrets or token literals are committed in manifests or hooks", () => {
  const files = [
    ...Object.values(VENDORS),
    join(PLUGIN, ".mcp.json"),
    join(PLUGIN, "hooks", "hooks.json"),
    join(ROOT, "gemini-extension.json"),
  ];
  for (const f of files) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /tly_(agt|pat)_[A-Za-z0-9]{8,}/, f);
  }
});

test("hook script stays dependency-free (node: builtins only)", () => {
  const src = readFileSync(join(PLUGIN, "hooks", "tallyline-hook.mjs"), "utf8");
  for (const m of src.matchAll(/from "([^"]+)"/g)) {
    assert.ok(m[1].startsWith("node:"), `non-builtin import ${m[1]}`);
  }
});

// The Claude Code CLI ships the authoritative plugin/marketplace schema. CI
// installs it; locally this runs when `claude` is on PATH.
const claudeCli = spawnSync("claude", ["--version"], { encoding: "utf8" });
const hasClaude = claudeCli.status === 0;
for (const target of [ROOT, PLUGIN]) {
  test(`claude plugin validate --strict ${target === ROOT ? "(marketplace)" : "(plugin)"}`, {
    skip: hasClaude ? false : "claude CLI not installed",
  }, () => {
    const r = spawnSync("claude", ["plugin", "validate", target, "--strict"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
}
