// Local MCP server exposing the assistant's tools to Claude Code.
// Bound to 127.0.0.1 on a random port and guarded by a per-run bearer token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolSpec } from "./assistant";

export interface ToolServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

export async function startToolServer(name: string, specs: ToolSpec[]): Promise<ToolServer> {
  const token = randomBytes(24).toString("hex");
  const build = () => {
    const server = new McpServer({ name, version: "1.0.0" });
    for (const spec of specs) {
      server.registerTool(spec.name, { description: spec.description, inputSchema: spec.schema.shape }, async (input: unknown) => {
        const text = await spec.run(input, `${spec.name}-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`);
        return { content: [{ type: "text" as const, text }] };
      });
    }
    return server;
  };

  const http = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || !req.url?.startsWith("/mcp")) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    // Stateless mode: a fresh server + transport per request.
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null }));
    }
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () => new Promise((resolve) => {
      http.closeAllConnections();
      http.close(() => resolve());
    }),
  };
}
