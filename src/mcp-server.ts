import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export { createGameMcpServer } from "./mcp-tools.js";

async function createStdioProxyServer(): Promise<Server> {
  // This file belongs to one player process. Never print it or share it across seats.
  const connectionFile = process.env.NIGHT_PORT_CONNECTION_FILE;
  const connection = connectionFile === undefined ? undefined : JSON.parse(readFileSync(connectionFile, "utf8")) as { localMcpUrl?: string; mcpUrl?: string; bearerToken?: string };
  const authoritativeUrl = new URL(connection?.mcpUrl ?? connection?.localMcpUrl ?? process.env.NIGHT_PORT_MCP_URL ?? "http://127.0.0.1:3188/mcp");
  if (authoritativeUrl.protocol !== "https:" && !(authoritativeUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(authoritativeUrl.hostname))) throw new Error("Use HTTPS or the local authority.");
  const remote = new Client({ name: "night-port-stdio-proxy", version: "0.3.0" });
  try { await remote.connect(new StreamableHTTPClientTransport(authoritativeUrl, connection?.bearerToken ? { requestInit: { headers: { authorization: `Bearer ${connection.bearerToken}` } } } : {})); }
  catch { throw new Error("Night Port authority unavailable. Check this client's connection configuration without printing its credentials."); }

  const listed = await remote.listTools();
  const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));
  const proxy = new Server(
    { name: "night-port-stdio-proxy", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions: "This STDIO endpoint is a stateless proxy to the authoritative Night Port HTTP MCP server."
    }
  );

  proxy.setRequestHandler("tools/list", async () => listed);
  proxy.setRequestHandler("tools/call", async (request) => {
    const advertised = tools.get(request.params.name);
    let response;
    try {
      response = await remote.callTool({
        name: request.params.name,
        ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments })
      });
    } catch {
      throw new Error("Night Port transport unavailable. Read current state after recovery before retrying an unconfirmed action.");
    }
    return proxy.projectCallToolResult(response, advertised?.outputSchema);
  });

  proxy.onclose = () => {
    void remote.close().catch(() => undefined);
  };
  return proxy;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void serveStdio(createStdioProxyServer);
}
