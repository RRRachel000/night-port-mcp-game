export type CommodityCategory = "cold_chain" | "ambient";

export type ControllerType = "ai" | "human" | "hybrid";

export type GamePhase =
  | "lobby"
  | "achievement_selection"
  | "active"
  | "carryover_vote"
  | "finished";

export interface CommodityConfig {
  id: string;
  name: string;
  category: CommodityCategory;
  basePrice: number;
  icon: string;
}

export interface OrderConfig {
  id: string;
  requirements: string[];
  reward: number;
}

export interface EventConfig {
  id: string;
  name: string;
  description: string;
  coldChainDelta: number;
  ambientDelta: number;
}

export type AchievementKind =
  | "empty_inventory"
  | "five_distinct"
  | "four_same"
  | "three_orders_one_round"
  | "three_cross_round_items"
  | "precise_round_three"
  | "inspection_both_early_rounds"
  | "never_inspection"
  | "two_large_orders"
  | "three_small_orders";

export interface AchievementConfig {
  id: string;
  name: string;
  description: string;
  kind: AchievementKind;
  bonus: number;
}

export interface GameConfig {
  gameName: string;
  playerCount: number;
  startingCash: number;
  rounds: number;
  marketSize: number;
  newOrdersPerRound: number;
  eventsPerRound: number;
  minPrice: number;
  maxPrice: number;
  maxPurchasesPerTurn: number;
  round3MaxTurnsPerPlayer: number;
  commodities: CommodityConfig[];
  orders: OrderConfig[];
  events: EventConfig[];
  achievements: AchievementConfig[];
}

export interface InventoryItem {
  id: string;
  commodityId: string;
  acquiredRound: number;
  marketPosition: number;
}

export interface PlayerStats {
  maxDistinctInventory: number;
  maxSameCommodity: number;
  completedByRound: Record<string, number>;
  crossRoundItemsUsed: number;
  inspectionCargoRounds: number[];
  fourItemOrders: number;
  twoItemOrders: number;
  roundThreePurchasedItemIds: string[];
  consumedItemIds: string[];
}

export interface PlayerState {
  id: string;
  name: string;
  controllerType: ControllerType;
  token: string;
  cash: number;
  inventory: InventoryItem[];
  completedOrderIds: string[];
  achievementCandidates: string[];
  chosenAchievementId: string | null;
  hasNextRoundPriority: boolean;
  hasEmergencyCoupon: boolean;
  emergencyCouponUsed: boolean;
  roundActionsTaken: number;
  roundActionsRemaining: number | null;
  stats: PlayerStats;
}

export interface MarketSlot {
  position: number;
  commodityId: string | null;
  inspectionCargo: boolean;
}

export interface RuntimeOrder {
  id: string;
  firstAppearedRound: number;
  carriedOver: boolean;
  completedBy: string | null;
  completedRound: number | null;
}

export interface PriceState {
  cold_chain: number;
  ambient: number;
}

export interface GameLogEntry {
  sequence: number;
  stateVersion: number;
  round: number;
  type: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface FinalResult {
  playerId: string;
  playerName: string;
  finalCash: number;
  baseProfit: number;
  achievementId: string;
  achievementCompleted: boolean;
  achievementBonus: number;
  finalScore: number;
  remainingInventory: number;
  completedOrders: number;
  rank: number;
  tied: boolean;
}

export interface GameSnapshot {
  schemaVersion: 2;
  id: string;
  seed: number;
  rngState: number;
  stateVersion: number;
  phase: GamePhase;
  creatorPlayerId: string;
  round: number;
  players: PlayerState[];
  prices: PriceState;
  currentEventIds: string[];
  market: MarketSlot[];
  runtimeOrders: RuntimeOrder[];
  currentOrderIds: string[];
  orderDeck: string[];
  nextOrderIndex: number;
  turnOrder: string[];
  currentTurnIndex: number;
  passChain: string[];
  carryoverVotes: Record<string, boolean>;
  carryoverResumePlayerId: string | null;
  log: GameLogEntry[];
  nextInventorySequence: number;
  finalResults: FinalResult[];
  createdAt: string;
  updatedAt: string;
}

export interface TurnAction {
  marketPositions?: number[];
  orderId?: string;
  emergencyOrderId?: string;
}
