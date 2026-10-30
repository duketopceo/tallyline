// S3-U6: the same steps `tallyline agent connect` follows, shown on the web.
// Keep in step with tools/cli/src/agent/connect-agent.ts (formats checked
// 2026-10-30 against each agent's docs).

export type AgentId = "claude" | "codex" | "cursor" | "opencode";

export interface AgentGuide {
  id: AgentId;
  label: string;
  /** where the entry goes, written the way people type it */
  path: string;
  /** what to paste when not using the CLI */
  snippet: string;
  /** how to finish sign-in inside the agent */
  signIn: string;
}

export const AGENT_IDS: AgentId[] = ["claude", "codex", "cursor", "opencode"];

export function mcpUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/mcp`;
}

const json = (key: string, entry: Record<string, unknown>) =>
  JSON.stringify({ [key]: { tallyline: entry } }, null, 2);

export function agentGuide(id: AgentId, apiUrl: string): AgentGuide {
  const url = mcpUrl(apiUrl);
  switch (id) {
    case "claude":
      return {
        id,
        label: "Claude Code",
        path: ".mcp.json in your project folder",
        snippet: json("mcpServers", { type: "http", url }),
        signIn: "Start Claude Code in that folder, type /mcp, pick tallyline and sign in.",
      };
    case "codex":
      return {
        id,
        label: "Codex",
        path: "~/.codex/config.toml",
        snippet: `[mcp_servers.tallyline]\nurl = ${JSON.stringify(url)}\nscopes = ["read", "write"]`,
        signIn: "Run: codex mcp login tallyline",
      };
    case "cursor":
      return {
        id,
        label: "Cursor",
        path: "~/.cursor/mcp.json",
        snippet: json("mcpServers", { url }),
        signIn: "Open Cursor Settings, then MCP, and press Connect next to tallyline.",
      };
    case "opencode":
      return {
        id,
        label: "opencode",
        path: "~/.config/opencode/opencode.json",
        snippet: json("mcp", { type: "remote", url, enabled: true }),
        signIn: "Run: opencode mcp auth tallyline",
      };
  }
}

export function connectCommand(id: AgentId): string {
  return `tallyline agent connect ${id}`;
}
