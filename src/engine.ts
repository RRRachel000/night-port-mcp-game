import { randomUUID } from "node:crypto";

import { DEFAULT_CONFIG, mergeConfig } from "./config.js";
import { SeededRandom, seedFromString } from "./random.js";
import type {
  AchievementConfig,
  CommodityConfig,
  ControllerType,
  FinalResult,
  GameConfig,
  GameLogEntry,
  GameSnapshot,
  InventoryItem,
  MarketSlot,
  PlayerState,
  RuntimeOrder,
  TurnAction
} from "./types.js";

export interface GameErrorDetails {
  stateVersion?: number;
  legalActions?: Record<string, unknown>;
  [key: string]: unknown;
}

export class GameRuleError extends Error {
  readonly code: string;
  readonly details: GameErrorDetails;

  constructor(code: string, message: string, details: GameErrorDetails = {}) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
    this.details = details;
  }
}

export interface CreateGameInput {
  gameId?: string;
  creatorId: string;
  creatorName: string;
  creatorType: ControllerType;
  creatorToken?: string;
  seed?: string | number;
}

export interface CreateGameResult {
  game: NightPortGame;
  playerToken: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function countBy<T extends string>(items: readonly T[]): Record<T, number> {
  const result = {} as Record<T, number>;
  for (const item of items) {
    result[item] = (result[item] ?? 0) + 1;
  }
  return result;
}

function initialStats(): PlayerState["stats"] {
  return {
    maxDistinctInventory: 0,
    maxSameCommodity: 0,
    completedByRound: {},
    crossRoundItemsUsed: 0,
    inspectionCargoRounds: [],
    fourItemOrders: 0,
    twoItemOrders: 0,
    roundThreePurchasedItemIds: [],
    consumedItemIds: []
  };
}

function makePlayer(
  id: string,
  name: string,
  controllerType: ControllerType,
  token: string,
  startingCash: number
): PlayerState {
  return {
    id,
    name,
    controllerType,
    token,
    cash: startingCash,
    inventory: [],
    completedOrderIds: [],
    achievementCandidates: [],
    chosenAchievementId: null,
    hasNextRoundPriority: false,
    hasEmergencyCoupon: false,
    emergencyCouponUsed: false,
    roundActionsTaken: 0,
    roundActionsRemaining: null,
    stats: initialStats()
  };
}

export class NightPortGame {
  readonly config: GameConfig;
  private readonly commodityById: Map<string, CommodityConfig>;
  private readonly orderById: Map<string, GameConfig["orders"][number]>;
  private readonly eventById: Map<string, GameConfig["events"][number]>;
  private readonly achievementById: Map<string, AchievementConfig>;
  private readonly rng: SeededRandom;
  private state: GameSnapshot;

  private constructor(snapshot: GameSnapshot, config: GameConfig) {
    this.config = config;
    this.state = structuredClone(snapshot);
    this.rng = new SeededRandom(snapshot.seed, snapshot.rngState);
    this.commodityById = new Map(config.commodities.map((commodity) => [commodity.id, commodity]));
    this.orderById = new Map(config.orders.map((order) => [order.id, order]));
    this.eventById = new Map(config.events.map((event) => [event.id, event]));
    this.achievementById = new Map(config.achievements.map((achievement) => [achievement.id, achievement]));
  }

  static create(input: CreateGameInput, overrides: Partial<GameConfig> = {}): CreateGameResult {
    const config = mergeConfig(overrides);
    if (input.creatorType !== "ai") {
      throw new GameRuleError(
        "AI_CREATOR_REQUIRED",
        "Only an AI-controlled player may create a game. Human and hybrid players may join an AI-created room."
      );
    }
    if (!input.creatorId.trim() || !input.creatorName.trim()) {
      throw new GameRuleError("INVALID_CREATOR", "creatorId and creatorName are required.");
    }

    const seed = typeof input.seed === "number"
      ? input.seed >>> 0
      : seedFromString(input.seed ?? randomUUID());
    const rng = new SeededRandom(seed);
    const token = input.creatorToken ?? randomUUID();
    const timestamp = nowIso();
    const gameId = input.gameId ?? randomUUID();
    const creator = makePlayer(input.creatorId, input.creatorName, input.creatorType, token, config.startingCash);
    const snapshot: GameSnapshot = {
      schemaVersion: 2,
      id: gameId,
      seed,
      rngState: rng.state,
      stateVersion: 1,
      phase: "lobby",
      creatorPlayerId: input.creatorId,
      round: 0,
      players: [creator],
      prices: {
        cold_chain: config.commodities.find((item) => item.category === "cold_chain")?.basePrice ?? 4,
        ambient: config.commodities.find((item) => item.category === "ambient")?.basePrice ?? 2
      },
      currentEventIds: [],
      market: [],
      runtimeOrders: [],
      currentOrderIds: [],
      orderDeck: rng.shuffle(config.orders.map((order) => order.id)),
      nextOrderIndex: 0,
      turnOrder: [],
      currentTurnIndex: 0,
      passChain: [],
      carryoverVotes: {},
      carryoverResumePlayerId: null,
      log: [{
        sequence: 1,
        stateVersion: 1,
        round: 0,
        type: "game_created",
        message: `${input.creatorName} 以 AI 主理人身份创建了港口商会房间。`,
        data: { creatorPlayerId: input.creatorId }
      }],
      nextInventorySequence: 1,
      finalResults: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    snapshot.rngState = rng.state;
    return { game: new NightPortGame(snapshot, config), playerToken: token };
  }

  static fromSnapshot(snapshot: GameSnapshot, overrides: Partial<GameConfig> = {}): NightPortGame {
    if (snapshot.schemaVersion !== 2) {
      throw new Error(`Unsupported snapshot schema version: ${String(snapshot.schemaVersion)}`);
    }
    return new NightPortGame(snapshot, mergeConfig(overrides));
  }

  get id(): string {
    return this.state.id;
  }

  get stateVersion(): number {
    return this.state.stateVersion;
  }

  exportSnapshot(): GameSnapshot {
    this.state.rngState = this.rng.state;
    return structuredClone(this.state);
  }

  joinPlayer(input: {
    playerId: string;
    playerName: string;
    controllerType: ControllerType;
    playerToken?: string;
    expectedStateVersion: number;
  }): { playerToken: string; stateVersion: number } {
    this.assertVersion(input.expectedStateVersion);
    this.assertPhase("lobby");
    if (this.state.players.length >= this.config.playerCount) {
      this.fail("ROOM_FULL", "All three merchant guild seats are occupied.");
    }
    if (this.state.players.some((player) => player.id === input.playerId)) {
      this.fail("PLAYER_ID_EXISTS", `Player id '${input.playerId}' is already in use.`);
    }
    if (!input.playerId.trim() || !input.playerName.trim()) {
      this.fail("INVALID_PLAYER", "playerId and playerName are required.");
    }
    const token = input.playerToken ?? randomUUID();
    this.state.players.push(makePlayer(
      input.playerId,
      input.playerName,
      input.controllerType,
      token,
      this.config.startingCash
    ));
    this.addLog("player_joined", `${input.playerName} joined the room.`, {
      playerId: input.playerId,
      controllerType: input.controllerType
    });
    this.commit();
    return { playerToken: token, stateVersion: this.state.stateVersion };
  }

  startGame(input: {
    playerId: string;
    playerToken: string;
    expectedStateVersion: number;
  }): { stateVersion: number; phase: string } {
    this.assertVersion(input.expectedStateVersion);
    this.assertPhase("lobby");
    const player = this.authorize(input.playerId, input.playerToken);
    if (player.id !== this.state.creatorPlayerId || player.controllerType !== "ai") {
      this.fail("START_PERMISSION_DENIED", "Only the AI player who created the room may start the game.");
    }
    if (this.state.players.length !== this.config.playerCount) {
      this.fail("SEATS_NOT_FULL", `The game requires exactly ${this.config.playerCount} occupied seats before it can start.`, {
        occupiedSeats: this.state.players.length
      });
    }

    for (const participant of this.state.players) {
      participant.achievementCandidates = this.rng
        .sample(this.config.achievements, 3)
        .map((achievement) => achievement.id);
    }
    this.state.phase = "achievement_selection";
    this.addLog("game_started", `${player.name} started the game. Hidden achievement selection is open.`);
    this.commit();
    return { stateVersion: this.state.stateVersion, phase: this.state.phase };
  }

  chooseAchievement(input: {
    playerId: string;
    playerToken: string;
    achievementId: string;
    expectedStateVersion: number;
  }): { stateVersion: number; phase: string } {
    this.assertVersion(input.expectedStateVersion);
    this.assertPhase("achievement_selection");
    const player = this.authorize(input.playerId, input.playerToken);
    if (player.chosenAchievementId !== null) {
      this.fail("ACHIEVEMENT_ALREADY_CHOSEN", "This player has already locked in a hidden achievement.");
    }
    if (!player.achievementCandidates.includes(input.achievementId)) {
      this.fail("INVALID_ACHIEVEMENT_CHOICE", "The chosen achievement is not one of this player's three candidates.");
    }
    player.chosenAchievementId = input.achievementId;
    player.achievementCandidates = [];
    this.addLog("achievement_chosen", `${player.name} locked in a hidden achievement.`, { playerId: player.id });

    if (this.state.players.every((participant) => participant.chosenAchievementId !== null)) {
      this.beginRound(1, []);
    }
    this.commit();
    return { stateVersion: this.state.stateVersion, phase: this.state.phase };
  }

  takeTurn(input: {
    playerId: string;
    playerToken: string;
    expectedStateVersion: number;
    action: TurnAction;
  }): Record<string, unknown> {
    this.assertVersion(input.expectedStateVersion);
    this.assertPhase("active");
    const player = this.authorize(input.playerId, input.playerToken);
    const currentPlayerId = this.currentPlayerId();
    if (player.id !== currentPlayerId) {
      this.fail("NOT_YOUR_TURN", `It is ${this.player(currentPlayerId).name}'s turn.`, { currentPlayerId });
    }
    if (this.state.round === 3 && (player.roundActionsRemaining ?? 0) <= 0) {
      this.fail("NO_ACTIONS_REMAINING", "This player has no third-round actions remaining.");
    }

    const positions = input.action.marketPositions ?? [];
    const orderId = input.action.orderId;
    const emergencyOrderId = input.action.emergencyOrderId;
    if (positions.length > this.config.maxPurchasesPerTurn) {
      this.fail("TOO_MANY_PURCHASES", `At most ${this.config.maxPurchasesPerTurn} market positions may be bought in one turn.`);
    }
    if (new Set(positions).size !== positions.length) {
      this.fail("DUPLICATE_MARKET_POSITION", "A market position may only be selected once per turn.");
    }
    if (emergencyOrderId !== undefined && orderId === undefined) {
      this.fail("PRIMARY_SETTLEMENT_REQUIRED", "The emergency coupon can only add a second settlement after a normal settlement.");
    }
    if (orderId !== undefined && emergencyOrderId === orderId) {
      this.fail("DUPLICATE_ORDER", "同一张航运委托不能重复核销。");
    }

    const selectedSlots = positions.map((position) => {
      if (!Number.isInteger(position) || position < 1 || position > this.config.marketSize) {
        this.fail("INVALID_MARKET_POSITION", `Market position ${position} is outside 1-${this.config.marketSize}.`);
      }
      const slot = this.state.market[position - 1];
      if (slot === undefined || slot.commodityId === null) {
        this.fail("MARKET_POSITION_EMPTY", `Market position ${position} is empty.`);
      }
      return { ...slot };
    });

    const totalCost = selectedSlots.reduce((sum, slot) => {
      const commodity = this.commodity(slot.commodityId!);
      return sum + this.state.prices[commodity.category];
    }, 0);
    if (totalCost > player.cash) {
      this.fail("INSUFFICIENT_CASH", `Purchase costs ${totalCost}, but ${player.name} only has ${player.cash}.`, {
        totalCost,
        availableCash: player.cash
      });
    }

    const prospectiveItems: InventoryItem[] = [];
    let nextSequence = this.state.nextInventorySequence;
    for (const slot of selectedSlots) {
      if (!slot.inspectionCargo) {
        prospectiveItems.push({
          id: `item-${nextSequence}`,
          commodityId: slot.commodityId!,
          acquiredRound: this.state.round,
          marketPosition: slot.position
        });
        nextSequence += 1;
      }
    }

    let workingInventory = [...player.inventory, ...prospectiveItems];
    const primary = orderId === undefined
      ? null
      : this.planSettlement(orderId, workingInventory);
    if (primary !== null) {
      workingInventory = primary.remainingInventory;
    }

    let emergency: ReturnType<NightPortGame["planSettlement"]> | null = null;
    if (emergencyOrderId !== undefined) {
      if (!player.hasEmergencyCoupon || player.emergencyCouponUsed) {
        this.fail("EMERGENCY_COUPON_UNAVAILABLE", "This player does not have an unused emergency settlement coupon.");
      }
      if (!this.isEmergencyCouponUnlocked()) {
        this.fail(
          "EMERGENCY_COUPON_LOCKED",
          "The emergency coupon unlocks only after all three players have completed at least one third-round action."
        );
      }
      emergency = this.planSettlement(emergencyOrderId, workingInventory);
      workingInventory = emergency.remainingInventory;
    }

    const isPass = positions.length === 0 && primary === null;
    if (emergency !== null && primary === null) {
      this.fail("PRIMARY_SETTLEMENT_REQUIRED", "Emergency settlement requires a normal settlement in the same turn.");
    }

    player.cash -= totalCost;
    player.inventory = workingInventory;
    this.state.nextInventorySequence = nextSequence;
    for (const slot of selectedSlots) {
      const marketSlot = this.state.market[slot.position - 1]!;
      marketSlot.commodityId = null;
      marketSlot.inspectionCargo = false;
      if (slot.inspectionCargo) {
        this.recordInspectionCargoPurchase(player);
      }
    }
    for (const item of prospectiveItems) {
      if (this.state.round === 3) {
        player.stats.roundThreePurchasedItemIds.push(item.id);
      }
    }
    this.updateInventoryHighWaterMarks(player, [...player.inventory, ...(primary?.consumedItems ?? []), ...(emergency?.consumedItems ?? [])]);

    const settledOrders: string[] = [];
    if (primary !== null) {
      this.applySettlement(player, primary, false);
      settledOrders.push(primary.runtime.id);
    }
    if (emergency !== null) {
      this.applySettlement(player, emergency, true);
      player.emergencyCouponUsed = true;
      settledOrders.push(emergency.runtime.id);
    }

    if (isPass) {
      this.state.passChain.push(player.id);
      this.addLog("player_passed", `${player.name} 未从货运市场采购，也未核销航运委托，选择 Pass。`, {
        playerId: player.id,
        passChain: [...this.state.passChain]
      });
    } else {
      this.state.passChain = [];
      this.state.carryoverVotes = {};
      if (positions.length > 0) {
        this.addLog("items_purchased", `${player.name} 从货运市场采购 ${positions.length} 件货物，支付 ${totalCost} 币。`, {
          playerId: player.id,
          positions,
          totalCost,
          inspectionCargoPositions: selectedSlots.filter((slot) => slot.inspectionCargo).map((slot) => slot.position)
        });
      }
    }

    player.roundActionsTaken += 1;
    if (this.state.round === 3) {
      player.roundActionsRemaining = Math.max(0, (player.roundActionsRemaining ?? 0) - 1);
    }

    const completedAllOrders = this.state.currentOrderIds.every((currentOrderId) =>
      this.runtimeOrder(currentOrderId).completedBy !== null
    );
    if (completedAllOrders) {
      if (this.state.round === this.config.rounds) {
        this.finishGame("终局全部航运委托已完成。");
      } else {
        this.beginRound(this.state.round + 1, []);
      }
    } else if (this.state.round === 3 && this.state.players.every((participant) =>
      (participant.roundActionsRemaining ?? 0) === 0
    )) {
      this.finishGame("第三轮所有行动次数均已用完。");
    } else if (this.state.passChain.length === this.config.playerCount) {
      this.resolveFullPassChain();
    } else if (this.state.market.every((slot) => slot.commodityId === null)) {
      this.refillEmptyMarketSlots();
      this.addLog("market_sold_out", "货运市场售空，18 个货位已补入普通货物。");
      this.advanceTurnAfter(player.id);
    } else {
      this.advanceTurnAfter(player.id);
    }

    this.commit();
    return {
      ok: true,
      stateVersion: this.state.stateVersion,
      playerId: player.id,
      purchasedPositions: positions,
      settledOrders,
      wasPass: isPass,
      phase: this.state.phase,
      currentPlayer: this.state.phase === "active" ? this.currentPlayerId() : null
    };
  }

  voteCarryover(input: {
    playerId: string;
    playerToken: string;
    approve: boolean;
    expectedStateVersion: number;
  }): Record<string, unknown> {
    this.assertVersion(input.expectedStateVersion);
    this.assertPhase("carryover_vote");
    const player = this.authorize(input.playerId, input.playerToken);
    this.state.carryoverVotes[player.id] = input.approve;
    this.addLog("carryover_vote", `${player.name} 投票${input.approve ? "原价结转未完成航运委托" : "继续当前轮"}。`, {
      playerId: player.id,
      approve: input.approve
    });

    if (!input.approve) {
      this.state.phase = "active";
      const resumeId = this.state.carryoverResumePlayerId ?? this.state.turnOrder[0]!;
      this.state.currentTurnIndex = Math.max(0, this.state.turnOrder.indexOf(resumeId));
      this.state.passChain = [];
      this.state.carryoverVotes = {};
      this.state.carryoverResumePlayerId = null;
      this.addLog("carryover_rejected", "航运委托结转未获一致同意，恢复正常行动。", { resumePlayerId: resumeId });
    } else if (this.state.players.every((participant) => this.state.carryoverVotes[participant.id] === true)) {
      const unresolvedIds = this.state.currentOrderIds.filter((id) => this.runtimeOrder(id).completedBy === null);
      this.beginRound(this.state.round + 1, unresolvedIds);
    }
    this.commit();
    return {
      ok: true,
      stateVersion: this.state.stateVersion,
      phase: this.state.phase,
      votes: { ...this.state.carryoverVotes }
    };
  }

  publicState(options: { includeProfitEstimates?: boolean } = {}): Record<string, unknown> {
    const orders = this.state.currentOrderIds.map((id) => {
      const runtime = this.runtimeOrder(id);
      const config = this.order(id);
      const purchaseCost = config.requirements.reduce((sum, commodityId) => {
        const commodity = this.commodity(commodityId);
        return sum + this.state.prices[commodity.category];
      }, 0);
      return {
        id,
        requirements: config.requirements.map((commodityId) => ({
          commodityId,
          name: this.commodity(commodityId).name
        })),
        reward: config.reward,
        completed: runtime.completedBy !== null,
        completedBy: runtime.completedBy,
        firstAppearedRound: runtime.firstAppearedRound,
        carriedOver: runtime.carriedOver,
        ...(options.includeProfitEstimates
          ? { theoreticalPurchaseCost: purchaseCost, theoreticalNetProfit: config.reward - purchaseCost }
          : {})
      };
    });
    const currentPlayer = this.state.phase === "active" ? this.currentPlayerId() : null;
    const publicPlayers = this.state.players.map((player) => ({
      id: player.id,
      name: player.name,
      controllerType: player.controllerType,
      cash: player.cash,
      inventory: player.inventory.map((item) => ({ ...item, commodityName: this.commodity(item.commodityId).name })),
      inventoryCounts: countBy(player.inventory.map((item) => item.commodityId)),
      completedOrderIds: [...player.completedOrderIds],
      hasNextRoundPriority: player.hasNextRoundPriority,
      hasEmergencyCoupon: player.hasEmergencyCoupon,
      emergencyCouponUsed: player.emergencyCouponUsed,
      roundActionsTaken: player.roundActionsTaken,
      roundActionsRemaining: player.roundActionsRemaining
    }));

    return {
      gameId: this.state.id,
      gameName: this.config.gameName,
      stateVersion: this.state.stateVersion,
      phase: this.state.phase,
      round: this.state.round,
      currentPlayer,
      turnOrder: [...this.state.turnOrder],
      prices: { ...this.state.prices },
      events: this.state.currentEventIds.map((id) => ({ ...this.event(id) })),
      orders,
      market: this.state.market.map((slot) => ({
        position: slot.position,
        occupied: slot.commodityId !== null,
        commodityId: slot.commodityId,
        commodityName: slot.commodityId === null ? null : this.commodity(slot.commodityId).name,
        category: slot.commodityId === null ? null : this.commodity(slot.commodityId).category,
        currentPrice: slot.commodityId === null
          ? null
          : this.state.prices[this.commodity(slot.commodityId).category],
        inspectionCargo: slot.inspectionCargo
      })),
      players: publicPlayers,
      passChain: [...this.state.passChain],
      marketEmptySlots: this.state.market.filter((slot) => slot.commodityId === null).length,
      roundVotes: { ...this.state.carryoverVotes },
      emergencyCouponUnlocked: this.isEmergencyCouponUnlocked(),
      endgameActionsRemaining: this.state.round === 3
        ? Object.fromEntries(this.state.players.map((player) => [player.id, player.roundActionsRemaining]))
        : null,
      finalResults: this.state.phase === "finished" ? structuredClone(this.state.finalResults) : [],
      recentLog: this.state.log.slice(-20).map((entry) => ({ ...entry })),
      legalActions: this.legalActions(),
      summary: this.summary()
    };
  }

  privateState(input: { playerId: string; playerToken: string }): Record<string, unknown> {
    const player = this.authorize(input.playerId, input.playerToken);
    const candidates = player.achievementCandidates.map((id) => this.achievement(id));
    const chosen = player.chosenAchievementId === null ? null : this.achievement(player.chosenAchievementId);
    return {
      gameId: this.state.id,
      stateVersion: this.state.stateVersion,
      playerId: player.id,
      achievementCandidates: candidates,
      chosenAchievement: chosen,
      achievementCompleted: chosen === null ? false : this.isAchievementComplete(player, chosen),
      hasEmergencyCoupon: player.hasEmergencyCoupon,
      emergencyCouponUnlocked: this.isEmergencyCouponUnlocked(),
      emergencyCouponUsed: player.emergencyCouponUsed,
      legalActions: this.legalActions(player.id)
    };
  }

  fullLog(): GameLogEntry[] {
    return structuredClone(this.state.log);
  }

  legalActions(playerId?: string): Record<string, unknown> {
    if (this.state.phase === "lobby") {
      return {
        phase: "lobby",
        mayJoin: this.state.players.length < this.config.playerCount,
        mayStart: this.state.players.length === this.config.playerCount,
        requiredStateVersion: this.state.stateVersion
      };
    }
    if (this.state.phase === "achievement_selection") {
      const player = playerId === undefined ? undefined : this.state.players.find((item) => item.id === playerId);
      return {
        phase: "achievement_selection",
        mayChooseAchievement: player?.chosenAchievementId === null,
        requiredStateVersion: this.state.stateVersion
      };
    }
    if (this.state.phase === "carryover_vote") {
      return {
        phase: "carryover_vote",
        mayVoteCarryover: playerId === undefined || this.state.carryoverVotes[playerId] === undefined,
        requiredStateVersion: this.state.stateVersion
      };
    }
    if (this.state.phase === "finished") {
      return { phase: "finished", actions: [] };
    }

    const currentPlayerId = this.currentPlayerId();
    const player = this.player(currentPlayerId);
    return {
      phase: "active",
      currentPlayerId,
      actorMatches: playerId === undefined ? undefined : playerId === currentPlayerId,
      marketPositions: this.state.market.filter((slot) => slot.commodityId !== null).map((slot) => slot.position),
      maxPurchases: this.config.maxPurchasesPerTurn,
      completableOrderIds: this.state.currentOrderIds.filter((id) => {
        const runtime = this.runtimeOrder(id);
        return runtime.completedBy === null && this.canSettle(this.order(id).requirements, player.inventory);
      }),
      mayPass: true,
      emergencyCouponAvailable: player.hasEmergencyCoupon
        && !player.emergencyCouponUsed
        && this.isEmergencyCouponUnlocked(),
      requiredStateVersion: this.state.stateVersion
    };
  }

  private beginRound(round: number, carriedOrderIds: string[]): void {
    this.state.round = round;
    this.state.phase = "active";
    for (const id of carriedOrderIds) {
      this.runtimeOrder(id).carriedOver = true;
    }
    const newOrderIds = this.state.orderDeck.slice(
      this.state.nextOrderIndex,
      this.state.nextOrderIndex + this.config.newOrdersPerRound
    );
    this.state.nextOrderIndex += newOrderIds.length;
    for (const id of newOrderIds) {
      this.state.runtimeOrders.push({
        id,
        firstAppearedRound: round,
        carriedOver: false,
        completedBy: null,
        completedRound: null
      });
    }
    this.state.currentOrderIds = [...carriedOrderIds, ...newOrderIds];

    const events = this.rng.sample(this.config.events, this.config.eventsPerRound);
    this.state.currentEventIds = events.map((event) => event.id);
    for (const event of events) {
      this.state.prices.cold_chain = clamp(
        this.state.prices.cold_chain + event.coldChainDelta,
        this.config.minPrice,
        this.config.maxPrice
      );
      this.state.prices.ambient = clamp(
        this.state.prices.ambient + event.ambientDelta,
        this.config.minPrice,
        this.config.maxPrice
      );
    }

    this.state.market = Array.from({ length: this.config.marketSize }, (_, index) => ({
      position: index + 1,
      commodityId: this.rng.pick(this.config.commodities).id,
      inspectionCargo: false
    }));
    this.state.market[this.rng.integer(this.config.marketSize)]!.inspectionCargo = true;

    const priorityPlayer = this.state.players.find((player) => player.hasNextRoundPriority);
    if (priorityPlayer === undefined) {
      this.state.turnOrder = this.rng.shuffle(this.state.players.map((player) => player.id));
    } else {
      const others = this.rng.shuffle(this.state.players.filter((player) => player.id !== priorityPlayer.id).map((player) => player.id));
      this.state.turnOrder = [priorityPlayer.id, ...others];
    }
    for (const player of this.state.players) {
      player.hasNextRoundPriority = false;
      player.roundActionsTaken = 0;
      player.roundActionsRemaining = round === 3 ? this.config.round3MaxTurnsPerPlayer : null;
    }
    this.state.currentTurnIndex = 0;
    this.state.passChain = [];
    this.state.carryoverVotes = {};
    this.state.carryoverResumePlayerId = null;
    this.addLog("round_started", `第 ${round} 轮开始，货运市场已完整刷新。`, {
      round,
      eventIds: this.state.currentEventIds,
      prices: { ...this.state.prices },
      turnOrder: [...this.state.turnOrder],
      priorityPlayerId: priorityPlayer?.id ?? null,
      newOrderIds,
      carriedOrderIds
    });
  }

  private planSettlement(orderId: string, inventory: InventoryItem[]): {
    runtime: RuntimeOrder;
    config: GameConfig["orders"][number];
    consumedItems: InventoryItem[];
    remainingInventory: InventoryItem[];
  } {
    if (!this.state.currentOrderIds.includes(orderId)) {
      this.fail("ORDER_NOT_AVAILABLE", `航运委托 ${orderId} 当前不可核销。`);
    }
    const runtime = this.runtimeOrder(orderId);
    if (runtime.completedBy !== null) {
      this.fail("ORDER_ALREADY_COMPLETED", `航运委托 ${orderId} 已由 ${runtime.completedBy} 核销。`);
    }
    const config = this.order(orderId);
    const remaining = [...inventory];
    const consumed: InventoryItem[] = [];
    for (const commodityId of config.requirements) {
      const index = remaining.findIndex((item) => item.commodityId === commodityId);
      if (index < 0) {
        this.fail("ORDER_REQUIREMENTS_NOT_MET", `库存不满足航运委托 ${orderId} 的货物要求。`, {
          orderId,
          requirements: config.requirements,
          inventory: inventory.map((item) => item.commodityId)
        });
      }
      consumed.push(remaining[index]!);
      remaining.splice(index, 1);
    }
    return { runtime, config, consumedItems: consumed, remainingInventory: remaining };
  }

  private applySettlement(
    player: PlayerState,
    settlement: ReturnType<NightPortGame["planSettlement"]>,
    emergency: boolean
  ): void {
    settlement.runtime.completedBy = player.id;
    settlement.runtime.completedRound = this.state.round;
    player.cash += settlement.config.reward;
    player.completedOrderIds.push(settlement.runtime.id);
    player.stats.completedByRound[String(this.state.round)] =
      (player.stats.completedByRound[String(this.state.round)] ?? 0) + 1;
    player.stats.crossRoundItemsUsed += settlement.consumedItems.filter((item) => item.acquiredRound < this.state.round).length;
    player.stats.consumedItemIds.push(...settlement.consumedItems.map((item) => item.id));
    if (settlement.config.requirements.length === 4) player.stats.fourItemOrders += 1;
    if (settlement.config.requirements.length === 2) player.stats.twoItemOrders += 1;
    this.addLog(
      emergency ? "emergency_order_settled" : "order_settled",
      `${player.name} 核销航运委托 #${settlement.runtime.id}，获得 ${settlement.config.reward} 币。`,
      {
        playerId: player.id,
        orderId: settlement.runtime.id,
        reward: settlement.config.reward,
        emergency,
        consumedItemIds: settlement.consumedItems.map((item) => item.id)
      }
    );
  }

  private resolveFullPassChain(): void {
    const firstPasserId = this.state.passChain[0]!;
    const emptySlots = this.state.market.filter((slot) => slot.commodityId === null).length;
    if (emptySlots > 0) {
      this.refillEmptyMarketSlots();
      this.state.passChain = [];
      this.state.currentTurnIndex = Math.max(0, this.state.turnOrder.indexOf(firstPasserId));
      if (this.state.round === 3 && (this.player(firstPasserId).roundActionsRemaining ?? 0) === 0) {
        this.advanceTurnAfter(firstPasserId);
      }
      this.addLog("pass_refill", `货运市场 ${emptySlots} 个空位已补货，由停手链中最先 Pass 的玩家继续行动。`, {
        emptySlots,
        firstPasserId
      });
      return;
    }

    this.state.passChain = [];
    if (this.state.round === 3) {
      this.finishGame("终局货运市场满盘且三方连续 Pass，游戏结束。");
      return;
    }
    this.state.phase = "carryover_vote";
    this.state.carryoverVotes = {};
    this.state.carryoverResumePlayerId = firstPasserId;
    this.addLog("carryover_vote_opened", "货运市场满盘且三方连续 Pass，现需一致表决是否原价结转未完成航运委托。", {
      resumePlayerId: firstPasserId
    });
  }

  private refillEmptyMarketSlots(): void {
    for (const slot of this.state.market) {
      if (slot.commodityId === null) {
        slot.commodityId = this.rng.pick(this.config.commodities).id;
        slot.inspectionCargo = false;
      }
    }
  }

  private recordInspectionCargoPurchase(player: PlayerState): void {
    if (!player.stats.inspectionCargoRounds.includes(this.state.round)) {
      player.stats.inspectionCargoRounds.push(this.state.round);
    }
    if (this.state.round < 3) {
      player.hasNextRoundPriority = true;
    } else {
      player.hasEmergencyCoupon = true;
    }
  }

  private updateInventoryHighWaterMarks(player: PlayerState, inventoryAtPeak: InventoryItem[]): void {
    const counts = Object.values(countBy(inventoryAtPeak.map((item) => item.commodityId)));
    player.stats.maxDistinctInventory = Math.max(
      player.stats.maxDistinctInventory,
      new Set(inventoryAtPeak.map((item) => item.commodityId)).size
    );
    player.stats.maxSameCommodity = Math.max(player.stats.maxSameCommodity, ...counts, 0);
  }

  private advanceTurnAfter(playerId: string): void {
    const startIndex = this.state.turnOrder.indexOf(playerId);
    for (let offset = 1; offset <= this.state.turnOrder.length; offset += 1) {
      const index = (startIndex + offset) % this.state.turnOrder.length;
      const candidateId = this.state.turnOrder[index]!;
      if (this.state.round !== 3 || (this.player(candidateId).roundActionsRemaining ?? 0) > 0) {
        this.state.currentTurnIndex = index;
        return;
      }
    }
  }

  private finishGame(reason: string): void {
    this.state.phase = "finished";
    const unsorted = this.state.players.map((player) => {
      const achievement = this.achievement(player.chosenAchievementId!);
      const completed = this.isAchievementComplete(player, achievement);
      const bonus = completed ? achievement.bonus : 0;
      return {
        playerId: player.id,
        playerName: player.name,
        finalCash: player.cash,
        baseProfit: player.cash - this.config.startingCash,
        achievementId: achievement.id,
        achievementCompleted: completed,
        achievementBonus: bonus,
        finalScore: player.cash - this.config.startingCash + bonus,
        remainingInventory: player.inventory.length,
        completedOrders: player.completedOrderIds.length
      };
    });
    unsorted.sort((left, right) =>
      right.finalScore - left.finalScore
      || left.remainingInventory - right.remainingInventory
      || right.completedOrders - left.completedOrders
    );
    const results: FinalResult[] = [];
    for (const [index, result] of unsorted.entries()) {
      const previous = unsorted[index - 1];
      const tiedWithPrevious = previous !== undefined
        && previous.finalScore === result.finalScore
        && previous.remainingInventory === result.remainingInventory
        && previous.completedOrders === result.completedOrders;
      const rank = tiedWithPrevious ? (results[index - 1]?.rank ?? index + 1) : index + 1;
      const next = unsorted[index + 1];
      const tiedWithNext = next !== undefined
        && next.finalScore === result.finalScore
        && next.remainingInventory === result.remainingInventory
        && next.completedOrders === result.completedOrders;
      results.push({ ...result, rank, tied: tiedWithPrevious || tiedWithNext });
    }
    this.state.finalResults = results;
    this.state.passChain = [];
    this.addLog("game_finished", reason, {
      results: results.map((result) => ({
        playerId: result.playerId,
        finalCash: result.finalCash,
        achievementBonus: result.achievementBonus,
        finalScore: result.finalScore,
        rank: result.rank
      }))
    });
  }

  private isAchievementComplete(player: PlayerState, achievement: AchievementConfig): boolean {
    switch (achievement.kind) {
      case "empty_inventory":
        return this.state.phase === "finished" && player.inventory.length === 0;
      case "five_distinct":
        return player.stats.maxDistinctInventory >= 5;
      case "four_same":
        return player.stats.maxSameCommodity >= 4;
      case "three_orders_one_round":
        return Object.values(player.stats.completedByRound).some((count) => count >= 3);
      case "three_cross_round_items":
        return player.stats.crossRoundItemsUsed >= 3;
      case "precise_round_three":
        return this.state.phase === "finished"
          && player.stats.roundThreePurchasedItemIds.length > 0
          && player.stats.roundThreePurchasedItemIds.every((id) => player.stats.consumedItemIds.includes(id));
      case "inspection_both_early_rounds":
        return player.stats.inspectionCargoRounds.includes(1) && player.stats.inspectionCargoRounds.includes(2);
      case "never_inspection":
        return this.state.phase === "finished" && player.stats.inspectionCargoRounds.length === 0;
      case "two_large_orders":
        return player.stats.fourItemOrders >= 2;
      case "three_small_orders":
        return player.stats.twoItemOrders >= 3;
    }
  }

  private isEmergencyCouponUnlocked(): boolean {
    return this.state.round === 3 && this.state.players.length === this.config.playerCount
      && this.state.players.every((player) => player.roundActionsTaken >= 1);
  }

  private canSettle(requirements: readonly string[], inventory: readonly InventoryItem[]): boolean {
    const available = countBy(inventory.map((item) => item.commodityId));
    const needed = countBy(requirements);
    return Object.entries(needed).every(([commodityId, count]) => (available[commodityId] ?? 0) >= count);
  }

  private assertVersion(expected: number): void {
    if (expected !== this.state.stateVersion) {
      this.fail("STATE_VERSION_CONFLICT", `Expected state version ${expected}, but the current version is ${this.state.stateVersion}.`, {
        expectedStateVersion: expected,
        currentStateVersion: this.state.stateVersion
      });
    }
  }

  private assertPhase(expected: GameSnapshot["phase"]): void {
    if (this.state.phase !== expected) {
      this.fail("INVALID_PHASE", `This operation requires phase '${expected}', but the game is in '${this.state.phase}'.`);
    }
  }

  private authorize(playerId: string, token: string): PlayerState {
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (player === undefined || player.token !== token) {
      this.fail("PLAYER_AUTH_FAILED", "Player id or private player token is invalid.");
    }
    return player;
  }

  private currentPlayerId(): string {
    const id = this.state.turnOrder[this.state.currentTurnIndex];
    if (id === undefined) {
      this.fail("NO_CURRENT_PLAYER", "The game has no current player.");
    }
    return id;
  }

  private player(id: string): PlayerState {
    const player = this.state.players.find((candidate) => candidate.id === id);
    if (player === undefined) throw new Error(`Unknown player '${id}'.`);
    return player;
  }

  private commodity(id: string): CommodityConfig {
    const commodity = this.commodityById.get(id);
    if (commodity === undefined) throw new Error(`Unknown commodity '${id}'.`);
    return commodity;
  }

  private order(id: string): GameConfig["orders"][number] {
    const order = this.orderById.get(id);
    if (order === undefined) throw new Error(`未知航运委托 '${id}'。`);
    return order;
  }

  private event(id: string): GameConfig["events"][number] {
    const event = this.eventById.get(id);
    if (event === undefined) throw new Error(`Unknown event '${id}'.`);
    return event;
  }

  private achievement(id: string): AchievementConfig {
    const achievement = this.achievementById.get(id);
    if (achievement === undefined) throw new Error(`Unknown achievement '${id}'.`);
    return achievement;
  }

  private runtimeOrder(id: string): RuntimeOrder {
    const runtime = this.state.runtimeOrders.find((candidate) => candidate.id === id);
    if (runtime === undefined) throw new Error(`航运委托 '${id}' 尚未进入本局。`);
    return runtime;
  }

  private addLog(type: string, message: string, data?: Record<string, unknown>): void {
    const entry: GameLogEntry = {
      sequence: this.state.log.length + 1,
      stateVersion: this.state.stateVersion + 1,
      round: this.state.round,
      type,
      message,
      ...(data === undefined ? {} : { data })
    };
    this.state.log.push(entry);
  }

  private commit(): void {
    this.state.stateVersion += 1;
    this.state.rngState = this.rng.state;
    this.state.updatedAt = nowIso();
  }

  private summary(): string {
    const current = this.state.phase === "active" ? this.player(this.currentPlayerId()).name : "—";
    return `${this.config.gameName} | phase=${this.state.phase} | round=${this.state.round}/${this.config.rounds} | version=${this.state.stateVersion} | current=${current}`;
  }

  private fail(code: string, message: string, extra: GameErrorDetails = {}): never {
    throw new GameRuleError(code, message, {
      stateVersion: this.state.stateVersion,
      legalActions: this.legalActions(),
      ...extra
    });
  }
}

export { DEFAULT_CONFIG };
