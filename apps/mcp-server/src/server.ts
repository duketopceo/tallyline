import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TallylineClient } from "./client.js";
import { executeTool, toolDefs } from "./tools.js";

export const SERVER_INFO = { name: "tallyline", version: "2.0.0" } as const;

/**
 * Build an McpServer with the full tallyline tool surface registered against
 * `client`. Transport-agnostic — index.ts connects stdio or HTTP.
 */
export function createMcpServer(client: TallylineClient): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: def.readOnly ? { readOnlyHint: true } : {},
      },
      (args) => executeTool(def, args, client),
    );
  }
  return server;
}
