import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike
} from "@modelcontextprotocol/node";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createGameMcpServer } from "./mcp-server.js";
import { GameStore } from "./store.js";
import { createWebServer } from "./web-server.js";

export interface AuthoritativeServer {
  store: GameStore;
  server: ReturnType<typeof createWebServer>;
  mcpHandler: McpHttpHandler;
}

export function createAuthoritativeServer(store = new GameStore()): AuthoritativeServer {
  const mcpHandler = createMcpHandler(
    () => createGameMcpServer(store),
    {
      legacy: "stateless",
      responseMode: "auto",
      onerror: (error) => console.error("Night Port MCP error:", error)
    }
  );
  const nodeMcpHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => console.error("Night Port MCP adapter error:", error)
  });
  const server = createWebServer(store, async (request, response) => {
    await nodeMcpHandler(
      request as unknown as NodeIncomingMessageLike,
      response as unknown as NodeServerResponseLike
    );
  });

  return { store, server, mcpHandler };
}

export function startAuthoritativeServer(): AuthoritativeServer {
  const host = process.env.NIGHT_PORT_HOST ?? process.env.NIGHT_PORT_WEB_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.NIGHT_PORT_PORT ?? process.env.NIGHT_PORT_WEB_PORT ?? "3188", 10);
  const runtime = createAuthoritativeServer();
  runtime.server.listen(port, host, () => {
    console.log(`Night Port authoritative server: http://${host}:${port}`);
    console.log(`Night Port Streamable HTTP MCP: http://${host}:${port}/mcp`);
  });
  return runtime;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  const runtime = startAuthoritativeServer();
  const shutdown = () => {
    runtime.server.close(() => {
      void runtime.mcpHandler.close().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
