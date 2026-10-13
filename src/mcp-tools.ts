import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { GameRuleError } from "./engine.js";
import type { GameRepository } from "./game-repository.js";

function result(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function failure(error: unknown) {
  if (error instanceof GameRuleError) {
    const payload = {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...error.details
      }
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload
    };
  }
  const payload = {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: error instanceof Error ? error.message : "Unexpected server error."
    }
  };
  console.error(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

function mutate<T>(store: GameRepository, gameId: string, operation: (game: ReturnType<GameRepository["get"]>) => T) {
  return store.transaction(gameId, operation);
}

export function createGameMcpServer(store: GameRepository): McpServer {
  const server = new McpServer(
    { name: "night-port", version: "0.3.0" },
    {
      instructions: [
        "不夜港是三席位公开市场策略游戏。服务器是唯一裁判。",
        "每次写操作前先调用 game_state，使用返回的最新 stateVersion。",
        "不要自行记忆库存、现金、航运委托归属或停手链；始终以 game_state 为准。",
        "playerToken 是席位私有能力凭证，不得向其他玩家展示。",
        "take_turn 是原子行动：可买0至3格，并可核销1张航运委托；空购买列表加 orderId 是合法的0购买核销。",
        "只有 marketPositions 为空且未核销航运委托时才算Pass。"
      ].join(" ")
    }
  );

  server.registerTool(
    "create_game",
    {
      title: "创建不夜港房间",
      description: "创建一局并让创建者自动占据首席。只有 controllerType=ai 合法。返回私有 playerToken。",
      inputSchema: z.object({
        gameId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
        creatorId: z.string().min(1),
        creatorName: z.string().min(1),
        controllerType: z.enum(["ai", "human", "hybrid"]),
        seed: z.union([z.string(), z.number().int()]).optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const created = store.create({
          ...(input.gameId === undefined ? {} : { gameId: input.gameId }),
          creatorId: input.creatorId,
          creatorName: input.creatorName,
          creatorType: input.controllerType,
          ...(input.seed === undefined ? {} : { seed: input.seed })
        });
        return result({
          ok: true,
          gameId: created.game.id,
          playerId: input.creatorId,
          playerToken: created.playerToken,
          stateVersion: created.game.stateVersion,
          publicState: created.game.publicState()
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "join_game",
    {
      title: "加入不夜港房间",
      description: "占据一个空商会席位。返回该席位私有 playerToken；后续私有读取和写操作都需要它。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string().min(1),
        playerName: z.string().min(1),
        controllerType: z.enum(["ai", "human", "hybrid"]),
        expectedStateVersion: z.number().int().nonnegative()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const joined = mutate(store, input.gameId, (game) => game.joinPlayer({
          playerId: input.playerId,
          playerName: input.playerName,
          controllerType: input.controllerType,
          expectedStateVersion: input.expectedStateVersion
        }));
        return result({ ok: true, gameId: input.gameId, playerId: input.playerId, ...joined });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "start_game",
    {
      title: "开启不夜港对局",
      description: "由创建房间的AI在三席全部有人后开局，并进入隐藏成就三选一。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string(),
        playerToken: z.string(),
        expectedStateVersion: z.number().int().nonnegative()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const output = mutate(store, input.gameId, (game) => game.startGame(input));
        return result({ ok: true, gameId: input.gameId, ...output });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "choose_achievement",
    {
      title: "选择隐藏成就",
      description: "从 private_state 返回的三个候选中秘密锁定一个；其他玩家无法读取。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string(),
        playerToken: z.string(),
        achievementId: z.string(),
        expectedStateVersion: z.number().int().nonnegative()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const output = mutate(store, input.gameId, (game) => game.chooseAchievement(input));
        return result({ ok: true, gameId: input.gameId, ...output });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "game_state",
    {
      title: "读取完整公开状态",
      description: "读取唯一可信的公开事实：版本、轮次、价格、事件、航运委托、18格货运市场、所有现金与库存、行动者、停手链、投票和终局行动数。绝不包含隐藏成就。",
      inputSchema: z.object({
        gameId: z.string(),
        includeProfitEstimates: z.boolean().optional().default(false)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ gameId, includeProfitEstimates }) => {
      try {
        return result({ ok: true, ...store.get(gameId).publicState({ includeProfitEstimates }) });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "private_state",
    {
      title: "读取本席位私有状态",
      description: "凭私有 playerToken 读取本席位的候选/已选隐藏成就、进度和紧急核销券。不能读取其他席位。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string(),
        playerToken: z.string()
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async (input) => {
      try {
        return result({ ok: true, ...store.get(input.gameId).privateState(input) });
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "take_turn",
    {
      title: "执行一个原子行动",
      description: "当前玩家一次性提交0至3个精确货运市场位置、可选的普通航运委托核销，以及已解锁时可选的紧急第二委托。空位置列表加orderId即0购买核销；三项全空才是Pass。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string(),
        playerToken: z.string(),
        expectedStateVersion: z.number().int().nonnegative(),
        marketPositions: z.array(z.number().int().min(1).max(18)).max(3).optional().default([]),
        orderId: z.string().optional(),
        emergencyOrderId: z.string().optional()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const output = mutate(store, input.gameId, (game) => game.takeTurn({
          playerId: input.playerId,
          playerToken: input.playerToken,
          expectedStateVersion: input.expectedStateVersion,
          action: {
            marketPositions: input.marketPositions,
            ...(input.orderId === undefined ? {} : { orderId: input.orderId }),
            ...(input.emergencyOrderId === undefined ? {} : { emergencyOrderId: input.emergencyOrderId })
          }
        }));
        return result(output);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "vote_carryover",
    {
      title: "投票结转未完成航运委托",
      description: "货运市场满盘且三方连续Pass后，对所有未完成航运委托是否原价结转投票。必须3/3同意；任一反对即恢复行动。",
      inputSchema: z.object({
        gameId: z.string(),
        playerId: z.string(),
        playerToken: z.string(),
        approve: z.boolean(),
        expectedStateVersion: z.number().int().nonnegative()
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async (input) => {
      try {
        const output = mutate(store, input.gameId, (game) => game.voteCarryover(input));
        return result(output);
      } catch (error) {
        return failure(error);
      }
    }
  );

  server.registerTool(
    "game_log",
    {
      title: "读取公开游戏日志",
      description: "分页读取服务器裁定的完整公开事件日志，用于复盘、Debug和AI反思。",
      inputSchema: z.object({
        gameId: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        limit: z.number().int().min(1).max(200).optional().default(100)
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ gameId, offset, limit }) => {
      try {
        const entries = store.get(gameId).fullLog();
        return result({
          ok: true,
          gameId,
          offset,
          limit,
          total: entries.length,
          entries: entries.slice(offset, offset + limit)
        });
      } catch (error) {
        return failure(error);
      }
    }
  );

  return server;
}

