#!/usr/bin/env node
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { TallylineClient } from "./client.js";
import {
  MissingEnvError,
  PassthroughAuthError,
  configFromHeaders,
  httpAuthMode,
  loadConfig,
} from "./env.js";
import { SERVER_INFO, createMcpServer } from "./server.js";
import { captureMcpException, initMcpTelemetry } from "./telemetry.js";
import { toolDefs } from "./tools.js";

// stdio is the default — what local MCP clients (Claude Code, Cursor,
// opencode) spawn. `--http[=PORT]` runs a stateless Streamable HTTP
// endpoint at /mcp instead, for clients that connect over the network.
function httpPort(argv: string[]): number | null {
  for (const arg of argv) {
    if (arg === "--http") return Number(process.env.MCP_HTTP_PORT ?? 3101);
    const m = /^--http=(\d+)$/.exec(arg);
    if (m) return Number(m[1]);
  }
  return null;
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "tallyline-mcp — Tallyline MCP server",
      "",
      "usage: tallyline-mcp [--http[=PORT]] [--help] [--version]",
      "",
      "  (default)      serve MCP over stdio",
      "  --http[=PORT]  serve stateless Streamable HTTP at /mcp (default 3101)",
      "",
      "env: TALLYLINE_TOKEN, TALLYLINE_WORKSPACE (required for stdio),",
      "     TALLYLINE_API_URL (default http://localhost:4000)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${SERVER_INFO.version}\n`);
  process.exit(0);
}

const port = httpPort(args);
initMcpTelemetry();

if (port === null) {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      process.stderr.write(`tallyline-mcp: ${err.message}\n`);
      process.exit(1);
    }
    captureMcpException(err);
    throw err;
  }
  const client = new TallylineClient(config);
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `tallyline-mcp: ${toolDefs.length} tools on stdio — ${config.apiUrl} ws=${config.workspace}\n`,
  );
} else {
  let auth: ReturnType<typeof httpAuthMode>;
  try {
    auth = httpAuthMode(process.env);
  } catch (err) {
    if (err instanceof MissingEnvError) {
      process.stderr.write(`tallyline-mcp: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
  const envClient =
    auth.mode === "env" ? new TallylineClient(auth.config) : null;

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/mcp") {
      let client = envClient;
      if (!client) {
        if (auth.mode !== "passthrough") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "no credential mode configured" }));
          return;
        }
        try {
          client = new TallylineClient(configFromHeaders(req.headers, auth));
        } catch (err) {
          if (err instanceof PassthroughAuthError) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
            return;
          }
          throw err;
        }
      }
      // Stateless: no sessionIdGenerator = no session tracking — each
      // request gets a fresh server+transport and any replica can serve it.
      const transport = new StreamableHTTPServerTransport({});
      const server = createMcpServer(client);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(
          transport as unknown as Parameters<typeof server.connect>[0],
        );
        await transport.handleRequest(req, res);
      } catch (err) {
        captureMcpException(err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal server error" }));
        }
      }
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "POST /mcp or GET /health" }));
  });
  http.listen(port, () => {
    const mode =
      auth.mode === "env"
        ? `env — ${auth.config.apiUrl} ws=${auth.config.workspace}`
        : `passthrough — api=${auth.apiUrl}${
            auth.allowApiUrlOverride ? " (api-url override on)" : ""
          }`;
    process.stderr.write(
      `tallyline-mcp: ${toolDefs.length} tools on http://localhost:${port}/mcp — ${mode}\n`,
    );
  });
}
