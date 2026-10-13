import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
  type NodeServerResponseLike
} from "@modelcontextprotocol/node";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { createGameMcpServer } from "./mcp-tools.js";
import { GameStore } from "./store.js";
import { createWebServer } from "./web-server.js";
import { WindowCoordinator } from "./window-coordinator.js";
import { createWindowMcpServer } from "./window-mcp.js";
import { handleWindowControl } from "./window-http.js";
import { acquireAuthorityLock } from "./authority-lock.js";

export interface AuthoritativeServer {
  store: GameStore;
  server: ReturnType<typeof createWebServer>;
  mcpHandler: McpHttpHandler;
  coordinator: WindowCoordinator;
  close: () => Promise<void>;
}

export function createAuthoritativeServer(store = new GameStore(), options: { operatorKey?: string } = {}): AuthoritativeServer {
  const coordinator = new WindowCoordinator(store);
  const seatHandlers = new Map<string, { handler: McpHttpHandler; nodeHandler: ReturnType<typeof toNodeHandler> }>();
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
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.startsWith("/mcp/seat/")) {
      const key = pathname.slice("/mcp/seat/".length);
      let connection;
      try { connection = coordinator.resolveConnection(key); }
      catch {
        response.writeHead(401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Seat connection invalid or revoked." }));
        return;
      }
      // Only one cached handler per live seat; revoke cached sessions on takeover.
      const cacheId = `${connection.gameId}:${connection.route.playerId}`;
      const cacheKey = `${cacheId}:${connection.route.generation}`;
      let cached = seatHandlers.get(cacheKey);
      if (!cached) {
        for (const [id, old] of seatHandlers) {
          if (id.startsWith(`${cacheId}:`)) { await old.handler.close(); seatHandlers.delete(id); }
        }
        const handler = createMcpHandler(() => createWindowMcpServer(coordinator, key), {
          legacy: "stateless", responseMode: "auto", onerror: () => console.error("Night Port seat MCP request failed.")
        });
        cached = { handler, nodeHandler: toNodeHandler(handler, { onerror: () => console.error("Night Port seat transport failed.") }) };
        seatHandlers.set(cacheKey, cached);
      }
      await cached.nodeHandler(request as unknown as NodeIncomingMessageLike, response as unknown as NodeServerResponseLike);
      return;
    }
    await nodeMcpHandler(
      request as unknown as NodeIncomingMessageLike,
      response as unknown as NodeServerResponseLike
    );
  }, { coordinator, handleControl: (request, response) => handleWindowControl(request, response, coordinator, options.operatorKey) });

  const close = async () => {
    await Promise.all([mcpHandler.close(), ...[...seatHandlers.values()].map((entry) => entry.handler.close())]);
    await new Promise<void>((done) => server.close(() => done()));
  };
  return { store, server, mcpHandler, coordinator, close };
}

export function startAuthoritativeServer(): AuthoritativeServer {
  const dataDirectory = resolve(process.env.NIGHT_PORT_DATA_DIR ?? "data/games");
  const cutoverFile = resolve(".local/cloud/cutover.json");
  if (existsSync(cutoverFile)) {
    const cutover = JSON.parse(readFileSync(cutoverFile, "utf8")) as { dataDirectory?: string };
    if (cutover.dataDirectory && resolve(cutover.dataDirectory) === dataDirectory) {
      throw new Error("This data directory was migrated to the cloud authority. Follow docs/cloud.md recovery steps before starting a local writer.");
    }
  }
  const releaseLock = acquireAuthorityLock(dataDirectory);
  process.once("exit", releaseLock);
  const host = process.env.NIGHT_PORT_HOST ?? process.env.NIGHT_PORT_WEB_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.NIGHT_PORT_PORT ?? process.env.NIGHT_PORT_WEB_PORT ?? "3188", 10);
  const operatorPath = resolve(process.env.NIGHT_PORT_OPERATOR_KEY_FILE ?? ".local/operator.key");
  mkdirSync(dirname(operatorPath), { recursive: true });
  if (!existsSync(operatorPath)) writeFileSync(operatorPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  const operatorKey = readFileSync(operatorPath, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(operatorKey)) throw new Error("Invalid operator key file.");
  const runtime = createAuthoritativeServer(new GameStore(dataDirectory), { operatorKey });
  const close = runtime.close;
  runtime.close = async () => {
    try { await close(); } finally { releaseLock(); process.removeListener("exit", releaseLock); }
  };
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
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
