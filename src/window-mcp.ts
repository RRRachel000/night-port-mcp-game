import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";

import { GameRuleError } from "./engine.js";
import { WindowCoordinator } from "./window-coordinator.js";

function respond(operation: () => Record<string, unknown>) {
  try {
    const payload = operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
  } catch (error) {
    const payload = { ok: false, error: error instanceof GameRuleError
      ? { code: error.code, message: error.message, ...error.details }
      : { code: "PERSISTENCE_OR_SERVER_ERROR", message: "The action was not confirmed. Reconnect and read my_state before retrying the same actionId." } };
    return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
  }
}

export function createWindowMcpServer(coordinator: WindowCoordinator, key: string): McpServer {
  const server = new McpServer({ name: "night-port-player", version: "0.3.0" }, {
    instructions: "This connection controls exactly one registered Night Port seat. Call my_state to recover your identity, private state and current task. No token needs to be remembered or supplied. Never disclose private state or the connection URL. Submit one decision using the current actionId and expectedStateVersion; an identical retry returns the original receipt."
  });
  server.registerTool("my_state", {
    title: "恢复我的不夜港席位",
    description: "读取此连接绑定的唯一席位、公开局面、本席位私有状态和当前任务。无需从聊天记忆查找凭证。",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async () => respond(() => coordinator.myState(key)));
  server.registerTool("submit_action", {
    title: "提交本席位的一次决定",
    description: "使用 my_state 的 actionId 和版本提交。网络响应丢失可用相同 actionId、版本与决定重试，不会重复执行。",
    inputSchema: z.object({
      actionId: z.string().uuid(),
      expectedStateVersion: z.number().int().nonnegative(),
      action: z.discriminatedUnion("type", [
        z.object({ type: z.literal("start") }),
        z.object({ type: z.literal("choose_achievement"), achievementId: z.string() }),
        z.object({ type: z.literal("vote_carryover"), approve: z.boolean() }),
        z.object({ type: z.literal("take_turn"), marketPositions: z.array(z.number().int().min(1).max(18)).max(3).default([]), orderId: z.string().optional(), emergencyOrderId: z.string().optional() })
      ])
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ actionId, expectedStateVersion, action }) => respond(() => coordinator.submit(key, actionId, expectedStateVersion,
    action.type === "take_turn" ? {
      type: action.type, marketPositions: action.marketPositions,
      ...(action.orderId === undefined ? {} : { orderId: action.orderId }),
      ...(action.emergencyOrderId === undefined ? {} : { emergencyOrderId: action.emergencyOrderId })
    } : action)));
  return server;
}
