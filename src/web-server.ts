import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { GameRuleError } from "./engine.js";
import { GameStore } from "./store.js";

const publicDirectory = resolve("public");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml"
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

type McpRequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createWebServer(store: GameStore, mcpRequestHandler?: McpRequestHandler) {
  return createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/mcp" && mcpRequestHandler !== undefined) {
      await mcpRequestHandler(request, response);
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: "Method not allowed." });
      return;
    }

    if (url.pathname === "/api/games") {
      const games = store.listGameIds().map((gameId) => {
        const state = store.get(gameId).publicState();
        return {
          gameId,
          gameName: state.gameName,
          phase: state.phase,
          round: state.round,
          stateVersion: state.stateVersion,
          summary: state.summary
        };
      });
      sendJson(response, 200, { ok: true, games });
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(response, 200, {
        ok: true,
        authoritative: mcpRequestHandler !== undefined,
        gameStore: "shared",
        mcpEndpoint: mcpRequestHandler === undefined ? null : "/mcp"
      });
      return;
    }

    const stateMatch = /^\/api\/games\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (stateMatch !== null) {
      const game = store.get(stateMatch[1]!);
      sendJson(response, 200, { ok: true, ...game.publicState({ includeProfitEstimates: true }) });
      return;
    }

    const logMatch = /^\/api\/games\/([A-Za-z0-9_-]+)\/log$/.exec(url.pathname);
    if (logMatch !== null) {
      const entries = store.get(logMatch[1]!).fullLog();
      const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
      const limit = Math.min(500, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "200", 10) || 200));
      sendJson(response, 200, { ok: true, total: entries.length, entries: entries.slice(offset, offset + limit) });
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[A-Za-z0-9._/-]+$/.test(relativePath) || relativePath.includes("..")) {
      sendJson(response, 400, { ok: false, error: "Invalid path." });
      return;
    }
    const filePath = resolve(publicDirectory, relativePath);
    if (!filePath.startsWith(publicDirectory)) {
      sendJson(response, 403, { ok: false, error: "Forbidden." });
      return;
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
    });
    response.end(body);
  } catch (error) {
    if (error instanceof GameRuleError) {
      sendJson(response, 404, { ok: false, error: { code: error.code, message: error.message } });
      return;
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      sendJson(response, 404, { ok: false, error: "Not found." });
      return;
    }
    console.error(error);
    sendJson(response, 500, { ok: false, error: "Internal server error." });
  }
  });
}
