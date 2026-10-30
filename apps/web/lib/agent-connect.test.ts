import { describe, expect, it } from "vitest";
import { AGENT_IDS, agentGuide, connectCommand, mcpUrl } from "./agent-connect";

const API = "https://tally.example.test/";

describe("agent connect guide", () => {
  it("points every agent at the server's /mcp endpoint", () => {
    expect(mcpUrl(API)).toBe("https://tally.example.test/mcp");
    for (const id of AGENT_IDS) {
      expect(agentGuide(id, API).snippet).toContain("https://tally.example.test/mcp");
      expect(connectCommand(id)).toBe(`tallyline agent connect ${id}`);
    }
  });

  it("uses each agent's own file shape", () => {
    expect(JSON.parse(agentGuide("claude", API).snippet)).toEqual({
      mcpServers: { tallyline: { type: "http", url: "https://tally.example.test/mcp" } },
    });
    expect(JSON.parse(agentGuide("cursor", API).snippet)).toEqual({
      mcpServers: { tallyline: { url: "https://tally.example.test/mcp" } },
    });
    expect(JSON.parse(agentGuide("opencode", API).snippet)).toEqual({
      mcp: { tallyline: { type: "remote", url: "https://tally.example.test/mcp", enabled: true } },
    });
    expect(agentGuide("codex", API).snippet).toBe(
      '[mcp_servers.tallyline]\nurl = "https://tally.example.test/mcp"\nscopes = ["read", "write"]',
    );
  });

  it("never offers review to an agent and never includes a key", () => {
    for (const id of AGENT_IDS) {
      const g = agentGuide(id, API);
      expect(g.snippet).not.toMatch(/review|token|key|secret/i);
    }
  });
});
