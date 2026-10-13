import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as z from "zod";

import { GameRuleError } from "./engine.js";
import { WindowCoordinator } from "./window-coordinator.js";

const route = z.object({ playerId: z.string().min(1).max(100), threadId: z.string().min(1).max(200), hostId: z.string().min(1).max(100), kind: z.enum(["codex", "chatgpt", "manual"]) });
const command = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list") }),
  z.object({ operation: z.literal("claim"), gameId: z.string() }),
  z.object({ operation: z.literal("status"), gameId: z.string() }),
  z.object({ operation: z.literal("bind"), gameId: z.string(), route, takeover: z.boolean().default(false) }),
  z.object({ operation: z.literal("pause"), gameId: z.string(), paused: z.boolean() }),
  z.object({ operation: z.literal("report"), gameId: z.string(), jobId: z.string().uuid(), dispatchId: z.string().uuid(), failure: z.enum(["window_unavailable", "transport_unavailable", "credential_unavailable", "dispatch_uncertain", "action_timeout"]).optional() })
]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export async function handleWindowControl(request: IncomingMessage, response: ServerResponse, coordinator: WindowCoordinator, operatorKey?: string): Promise<void> {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(operatorKey ?? "");
  if (!operatorKey || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    json(response, 401, { ok: false, error: { code: "OPERATOR_AUTH_REQUIRED" } });
    return;
  }
  if (request.method !== "POST") { json(response, 405, { ok: false }); return; }
  try {
    const buffers: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      length += buffer.length;
      if (length > 16_384) { json(response, 413, { ok: false }); return; }
      buffers.push(buffer);
    }
    const input = command.parse(JSON.parse(Buffer.concat(buffers).toString("utf8")));
    let result: unknown;
    switch (input.operation) {
      case "list": result = { games: coordinator.store.listGameIds().filter(id => coordinator.store.windowControl(id) !== undefined)
        .map(gameId => ({ gameId, runtime: coordinator.publicStatus(gameId) })) }; break;
      case "claim": result = { task: coordinator.claim(input.gameId), runtime: coordinator.publicStatus(input.gameId) }; break;
      case "status": result = coordinator.publicStatus(input.gameId); break;
      case "bind": result = coordinator.bind(input.gameId, input.route, input.takeover); break;
      case "pause": coordinator.setPaused(input.gameId, input.paused); result = coordinator.publicStatus(input.gameId); break;
      case "report": result = coordinator.report(input.gameId, input.jobId, input.dispatchId, input.failure); break;
    }
    json(response, 200, { ok: true, result });
  } catch (error) {
    if (error instanceof GameRuleError) json(response, 409, { ok: false, error: { code: error.code, message: error.message } });
    else if (error instanceof SyntaxError || error instanceof z.ZodError) json(response, 400, { ok: false, error: { code: "INVALID_REQUEST" } });
    else json(response, 500, { ok: false, error: { code: "CONTROL_NOT_CONFIRMED" } });
  }
}
