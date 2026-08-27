import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG, GameRuleError, NightPortGame } from "../src/engine.js";
import type { GameConfig, GameSnapshot, InventoryItem } from "../src/types.js";

const TOKENS = { a: "token-a", b: "token-b", c: "token-c" } as const;

function tokenFor(playerId: string): string {
  const token = TOKENS[playerId as keyof typeof TOKENS];
  if (token === undefined) throw new Error(`Missing token for ${playerId}`);
  return token;
}

function createLobby(overrides: Partial<GameConfig> = {}): NightPortGame {
  return NightPortGame.create({
    gameId: "test-game",
    creatorId: "a",
    creatorName: "A",
    creatorType: "ai",
    creatorToken: TOKENS.a,
    seed: "night-port-test"
  }, overrides).game;
}

function createStartedGame(overrides: Partial<GameConfig> = {}): NightPortGame {
  const game = createLobby(overrides);
  game.joinPlayer({
    playerId: "b",
    playerName: "B",
    controllerType: "ai",
    playerToken: TOKENS.b,
    expectedStateVersion: game.stateVersion
  });
  game.joinPlayer({
    playerId: "c",
    playerName: "C",
    controllerType: "human",
    playerToken: TOKENS.c,
    expectedStateVersion: game.stateVersion
  });
  game.startGame({ playerId: "a", playerToken: TOKENS.a, expectedStateVersion: game.stateVersion });
  for (const playerId of ["a", "b", "c"]) {
    const privateState = game.privateState({ playerId, playerToken: tokenFor(playerId) });
    const candidates = privateState.achievementCandidates as Array<{ id: string }>;
    game.chooseAchievement({
      playerId,
      playerToken: tokenFor(playerId),
      achievementId: candidates[0]!.id,
      expectedStateVersion: game.stateVersion
    });
  }
  return game;
}

function remake(
  game: NightPortGame,
  mutate: (snapshot: GameSnapshot) => void,
  overrides: Partial<GameConfig> = {}
): NightPortGame {
  const snapshot = game.exportSnapshot();
  mutate(snapshot);
  return NightPortGame.fromSnapshot(snapshot, overrides);
}

function item(id: string, commodityId: string, acquiredRound = 1): InventoryItem {
  return { id, commodityId, acquiredRound, marketPosition: 1 };
}

function activeFixture(overrides: Partial<GameConfig> = {}): NightPortGame {
  return remake(createStartedGame(overrides), (snapshot) => {
    snapshot.phase = "active";
    snapshot.turnOrder = ["a", "b", "c"];
    snapshot.currentTurnIndex = 0;
    snapshot.passChain = [];
    snapshot.currentOrderIds = ["1", "18"];
    snapshot.runtimeOrders = [
      { id: "1", firstAppearedRound: 1, carriedOver: false, completedBy: null, completedRound: null },
      { id: "18", firstAppearedRound: 1, carriedOver: false, completedBy: null, completedRound: null }
    ];
    snapshot.market = Array.from({ length: 18 }, (_, index) => ({
      position: index + 1,
      commodityId: DEFAULT_CONFIG.commodities[index % DEFAULT_CONFIG.commodities.length]!.id,
      inspectionCargo: false
    }));
  }, overrides);
}

function take(game: NightPortGame, playerId: string, action: Parameters<NightPortGame["takeTurn"]>[0]["action"]) {
  return game.takeTurn({
    playerId,
    playerToken: tokenFor(playerId),
    expectedStateVersion: game.stateVersion,
    action
  });
}

function expectRuleError(action: () => unknown, code: string): GameRuleError {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof GameRuleError);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`Expected GameRuleError '${code}'.`);
}

test("01 轮内买3件后三组连续Pass只补3件，原15件不变", () => {
  const game = activeFixture();
  const before = game.exportSnapshot().market.map((slot) => slot.commodityId);
  take(game, "a", { marketPositions: [1, 2, 3] });
  take(game, "b", {});
  take(game, "c", {});
  take(game, "a", {});

  const state = game.publicState();
  const market = state.market as Array<{ position: number; commodityId: string | null; occupied: boolean }>;
  assert.ok(market.slice(0, 3).every((slot) => slot.occupied));
  assert.deepEqual(market.slice(3).map((slot) => slot.commodityId), before.slice(3));
  assert.equal(state.currentPlayer, "b");
  assert.deepEqual(state.passChain, []);
});

test("02 进入新一轮整盘刷新市场但保留玩家仓库", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.market = snapshot.market.map((slot) => ({ ...slot, commodityId: "seafood", inspectionCargo: false }));
    snapshot.currentOrderIds = ["1"];
    snapshot.runtimeOrders = [
      { id: "1", firstAppearedRound: 1, carriedOver: false, completedBy: null, completedRound: null }
    ];
    snapshot.players[0]!.inventory = [
      item("tea", "tea"),
      item("spices", "spices"),
      item("carry", "tropical_fruit")
    ];
  });
  take(game, "a", { orderId: "1" });
  const snapshot = game.exportSnapshot();
  assert.equal(snapshot.round, 2);
  assert.equal(snapshot.market.length, 18);
  assert.ok(snapshot.market.some((slot) => slot.commodityId !== "seafood"));
  assert.deepEqual(snapshot.players[0]!.inventory.map((entry) => entry.id), ["carry"]);
});

test("03 0购买可以直接核销已有库存，且不算Pass", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.players[0]!.inventory = [item("t", "tea"), item("s", "spices")];
  });
  const cashBefore = game.exportSnapshot().players[0]!.cash;
  const result = take(game, "a", { marketPositions: [], orderId: "1" });
  assert.equal(result.wasPass, false);
  assert.equal(game.exportSnapshot().players[0]!.cash, cashBefore + 8);
  assert.deepEqual(game.exportSnapshot().passChain, []);
});

test("04 0购买且0核销计为Pass", () => {
  const game = activeFixture();
  const result = take(game, "a", { marketPositions: [] });
  assert.equal(result.wasPass, true);
  assert.deepEqual(game.exportSnapshot().passChain, ["a"]);
});

test("05 Pass链中间有人采购会完全重置", () => {
  const game = activeFixture();
  take(game, "a", {});
  assert.deepEqual(game.exportSnapshot().passChain, ["a"]);
  take(game, "b", { marketPositions: [1] });
  assert.deepEqual(game.exportSnapshot().passChain, []);
});

test("06 第一轮购买海关查验货获得下一轮优先权", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.market[0]!.inspectionCargo = true;
  });
  take(game, "a", { marketPositions: [1] });
  assert.equal(game.exportSnapshot().players[0]!.hasNextRoundPriority, true);
  assert.equal(game.exportSnapshot().players[0]!.inventory.length, 0);
});

test("07 第三轮海关查验货授予紧急核销券而非下一轮优先权", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.round = 3;
    snapshot.market[0]!.inspectionCargo = true;
    for (const player of snapshot.players) {
      player.roundActionsRemaining = 4;
      player.roundActionsTaken = 0;
    }
  });
  take(game, "a", { marketPositions: [1] });
  const player = game.exportSnapshot().players[0]!;
  assert.equal(player.hasEmergencyCoupon, true);
  assert.equal(player.hasNextRoundPriority, false);
});

test("08 三组完成首次第三轮行动前紧急核销券不可用", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.round = 3;
    snapshot.players[0]!.hasEmergencyCoupon = true;
    snapshot.players[0]!.inventory = [
      item("t1", "tea"), item("s1", "spices"),
      item("f1", "seafood"), item("w1", "timber"),
      item("b1", "flowers"), item("r1", "tropical_fruit")
    ];
    for (const player of snapshot.players) {
      player.roundActionsRemaining = 4;
      player.roundActionsTaken = 0;
    }
  });
  expectRuleError(
    () => take(game, "a", { orderId: "1", emergencyOrderId: "18" }),
    "EMERGENCY_COUPON_LOCKED"
  );
});

test("09 A核销后的订单不能被B重复核销", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.currentTurnIndex = 1;
    snapshot.runtimeOrders[0]!.completedBy = "a";
    snapshot.runtimeOrders[0]!.completedRound = 1;
    snapshot.players[1]!.inventory = [item("t", "tea"), item("s", "spices")];
  });
  expectRuleError(() => take(game, "b", { orderId: "1" }), "ORDER_ALREADY_COMPLETED");
});

test("10 跨轮订单保留原酬劳且被标记为遗留", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.phase = "carryover_vote";
    snapshot.round = 1;
    snapshot.currentOrderIds = ["1"];
    snapshot.runtimeOrders = [
      { id: "1", firstAppearedRound: 1, carriedOver: false, completedBy: null, completedRound: null }
    ];
  });
  for (const playerId of ["a", "b", "c"]) {
    game.voteCarryover({
      playerId,
      playerToken: tokenFor(playerId),
      approve: true,
      expectedStateVersion: game.stateVersion
    });
  }
  const order = (game.publicState().orders as Array<{ id: string; reward: number; carriedOver: boolean }>)
    .find((entry) => entry.id === "1")!;
  assert.equal(order.reward, 8);
  assert.equal(order.carriedOver, true);
});

test("11 新轮价格以上轮价格为基础继续累计并受上下限约束", () => {
  const events = [
    { id: "up-one", name: "上涨一", description: "冷链货价+1", coldChainDelta: 1, ambientDelta: 0 },
    { id: "up-two", name: "上涨二", description: "冷链货价+1", coldChainDelta: 1, ambientDelta: 0 }
  ];
  let game = createStartedGame({ events });
  assert.equal(game.exportSnapshot().prices.cold_chain, 6);
  game = remake(game, (snapshot) => {
    snapshot.phase = "carryover_vote";
    snapshot.currentOrderIds = [snapshot.currentOrderIds[0]!];
    snapshot.runtimeOrders = snapshot.runtimeOrders.filter((order) => order.id === snapshot.currentOrderIds[0]);
  }, { events });
  for (const playerId of ["a", "b", "c"]) {
    game.voteCarryover({ playerId, playerToken: tokenFor(playerId), approve: true, expectedStateVersion: game.stateVersion });
  }
  assert.equal(game.exportSnapshot().prices.cold_chain, 8);
});

test("12 终局死库存不返还现金", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.round = 3;
    snapshot.players[0]!.inventory = [item("dead", "seafood")];
    snapshot.players[0]!.cash = 17;
    snapshot.players[0]!.roundActionsRemaining = 1;
    snapshot.players[1]!.roundActionsRemaining = 0;
    snapshot.players[2]!.roundActionsRemaining = 0;
  });
  take(game, "a", {});
  const result = game.exportSnapshot().finalResults.find((entry) => entry.playerId === "a")!;
  assert.equal(result.finalCash, 17);
  assert.equal(result.remainingInventory, 1);
});

test("13 公开状态不泄露任一隐藏成就或候选", () => {
  const game = createStartedGame();
  const serialized = JSON.stringify(game.publicState());
  assert.equal(serialized.includes("chosenAchievement"), false);
  assert.equal(serialized.includes("achievementCandidates"), false);
  assert.equal(serialized.includes("achievementId"), false);
});

test("14 最终排名只按现金减本金一次，不重复扣死库存采购成本", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.round = 3;
    snapshot.players[0]!.cash = 45;
    snapshot.players[0]!.inventory = [item("dead", "seafood")];
    snapshot.players[0]!.roundActionsRemaining = 1;
    snapshot.players[1]!.roundActionsRemaining = 0;
    snapshot.players[2]!.roundActionsRemaining = 0;
  });
  take(game, "a", {});
  const result = game.exportSnapshot().finalResults.find((entry) => entry.playerId === "a")!;
  assert.equal(result.baseProfit, 15);
});

test("15 成就奖励仅进入最终成绩，不进入实时可消费现金", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.round = 3;
    snapshot.players[0]!.cash = 40;
    snapshot.players[0]!.chosenAchievementId = "never_inspection";
    snapshot.players[0]!.stats.inspectionCargoRounds = [];
    snapshot.players[0]!.roundActionsRemaining = 1;
    snapshot.players[1]!.roundActionsRemaining = 0;
    snapshot.players[2]!.roundActionsRemaining = 0;
  });
  take(game, "a", {});
  const result = game.exportSnapshot().finalResults.find((entry) => entry.playerId === "a")!;
  assert.equal(result.finalCash, 40);
  assert.equal(result.achievementBonus, 3);
  assert.equal(result.finalScore, 13);
});

test("16 真人或混合控制者不能创建房间", () => {
  for (const creatorType of ["human", "hybrid"] as const) {
    expectRuleError(() => NightPortGame.create({
      creatorId: "x",
      creatorName: "X",
      creatorType,
      seed: "no"
    }), "AI_CREATOR_REQUIRED");
  }
});

test("17 AI创建者自动占据一个席位，私有令牌不进入公开状态", () => {
  const game = createLobby();
  const state = game.publicState();
  const players = state.players as Array<{ id: string }>;
  assert.deepEqual(players.map((player) => player.id), ["a"]);
  assert.equal(JSON.stringify(state).includes(TOKENS.a), false);
});

test("18 非创建者即使是AI也不能start", () => {
  const game = createLobby();
  game.joinPlayer({ playerId: "b", playerName: "B", controllerType: "ai", playerToken: TOKENS.b, expectedStateVersion: game.stateVersion });
  game.joinPlayer({ playerId: "c", playerName: "C", controllerType: "ai", playerToken: TOKENS.c, expectedStateVersion: game.stateVersion });
  expectRuleError(
    () => game.startGame({ playerId: "b", playerToken: TOKENS.b, expectedStateVersion: game.stateVersion }),
    "START_PERMISSION_DENIED"
  );
});

test("19 三席未满时创建者不能start", () => {
  const game = createLobby();
  expectRuleError(
    () => game.startGame({ playerId: "a", playerToken: TOKENS.a, expectedStateVersion: game.stateVersion }),
    "SEATS_NOT_FULL"
  );
});

test("20 过期state_version写操作被拒绝且不产生状态变化", () => {
  const game = activeFixture();
  const currentVersion = game.stateVersion;
  take(game, "a", {});
  const snapshotBefore = game.exportSnapshot();
  expectRuleError(() => game.takeTurn({
    playerId: "b",
    playerToken: TOKENS.b,
    expectedStateVersion: currentVersion,
    action: {}
  }), "STATE_VERSION_CONFLICT");
  assert.deepEqual(game.exportSnapshot(), snapshotBefore);
});

test("21 非法操作返回失败原因、最新版本和合法操作范围", () => {
  const game = activeFixture();
  const error = expectRuleError(
    () => take(game, "a", { marketPositions: [1, 1] }),
    "DUPLICATE_MARKET_POSITION"
  );
  assert.equal(error.details.stateVersion, game.stateVersion);
  assert.ok(error.details.legalActions);
});

test("22 第三轮每组默认4次行动且保持配置化", () => {
  let game = activeFixture();
  game = remake(game, (snapshot) => {
    snapshot.phase = "carryover_vote";
    snapshot.round = 2;
    snapshot.currentOrderIds = ["1"];
    snapshot.runtimeOrders = [
      { id: "1", firstAppearedRound: 2, carriedOver: false, completedBy: null, completedRound: null }
    ];
  });
  for (const playerId of ["a", "b", "c"]) {
    game.voteCarryover({ playerId, playerToken: tokenFor(playerId), approve: true, expectedStateVersion: game.stateVersion });
  }
  assert.deepEqual(game.exportSnapshot().players.map((player) => player.roundActionsRemaining), [4, 4, 4]);
});
