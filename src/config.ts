import type { GameConfig } from "./types.js";

export const DEFAULT_CONFIG: GameConfig = {
  gameName: "不夜港：最后一班船",
  playerCount: 3,
  startingCash: 30,
  rounds: 3,
  marketSize: 18,
  newOrdersPerRound: 6,
  eventsPerRound: 2,
  minPrice: 1,
  maxPrice: 8,
  maxPurchasesPerTurn: 3,
  round3MaxTurnsPerPlayer: 4,
  commodities: [
    { id: "seafood", name: "海产", category: "cold_chain", basePrice: 4, icon: "seafood" },
    { id: "flowers", name: "鲜花", category: "cold_chain", basePrice: 4, icon: "flowers" },
    { id: "tropical_fruit", name: "热带果", category: "cold_chain", basePrice: 4, icon: "tropical-fruit" },
    { id: "tea", name: "茶叶", category: "ambient", basePrice: 2, icon: "tea" },
    { id: "spices", name: "香料", category: "ambient", basePrice: 2, icon: "spices" },
    { id: "timber", name: "木料", category: "ambient", basePrice: 2, icon: "timber" }
  ],
  orders: [
    { id: "1", requirements: ["tea", "spices"], reward: 8 },
    { id: "2", requirements: ["spices", "flowers"], reward: 11 },
    { id: "3", requirements: ["spices", "seafood"], reward: 11 },
    { id: "4", requirements: ["timber", "flowers"], reward: 11 },
    { id: "5", requirements: ["seafood", "timber"], reward: 11 },
    { id: "6", requirements: ["flowers", "tropical_fruit"], reward: 14 },
    { id: "7", requirements: ["tea", "timber", "tropical_fruit"], reward: 15 },
    { id: "8", requirements: ["tea", "spices", "seafood"], reward: 15 },
    { id: "9", requirements: ["timber", "flowers", "tropical_fruit"], reward: 18 },
    { id: "10", requirements: ["tea", "seafood", "tropical_fruit"], reward: 18 },
    { id: "11", requirements: ["tea", "flowers", "tropical_fruit"], reward: 18 },
    { id: "12", requirements: ["spices", "seafood", "flowers"], reward: 18 },
    { id: "13", requirements: ["tea", "spices", "timber", "tropical_fruit"], reward: 19 },
    { id: "14", requirements: ["tea", "spices", "seafood", "timber"], reward: 19 },
    { id: "15", requirements: ["tea", "spices", "flowers", "tropical_fruit"], reward: 22 },
    { id: "16", requirements: ["spices", "seafood", "timber", "flowers"], reward: 22 },
    { id: "17", requirements: ["tea", "seafood", "timber", "tropical_fruit"], reward: 22 },
    { id: "18", requirements: ["seafood", "timber", "flowers", "tropical_fruit"], reward: 27 }
  ],
  events: [
    { id: "cold_storage_tension", name: "冷库紧张", description: "冷链货价 +2", coldChainDelta: 2, ambientDelta: 0 },
    { id: "cold_chain_subsidy", name: "冷链补贴", description: "冷链货价 -1", coldChainDelta: -1, ambientDelta: 0 },
    { id: "refrigerated_arrival", name: "冷链大宗到港", description: "冷链货价 -2", coldChainDelta: -2, ambientDelta: 0 },
    { id: "cold_chain_export_rush", name: "冷链出口急单", description: "冷链货价 +1", coldChainDelta: 1, ambientDelta: 0 },
    { id: "ambient_road_congestion", name: "陆运拥堵", description: "常温货价 +1", coldChainDelta: 0, ambientDelta: 1 },
    { id: "ambient_bulk_arrival", name: "常温货到港", description: "常温货价 -1", coldChainDelta: 0, ambientDelta: -1 },
    { id: "ambient_shortage", name: "常温货短缺", description: "常温货价 +2", coldChainDelta: 0, ambientDelta: 2 },
    { id: "ambient_clearance", name: "常温货清仓", description: "常温货价 -2", coldChainDelta: 0, ambientDelta: -2 },
    { id: "route_adjustment", name: "航线调整", description: "冷链货价 +1，常温货价 -1", coldChainDelta: 1, ambientDelta: -1 },
    { id: "harbor_storm", name: "港区风暴", description: "冷链货价 -2，常温货价 +2", coldChainDelta: -2, ambientDelta: 2 },
    { id: "night_clearance", name: "夜航放行", description: "冷链货价 -1，常温货价 -1", coldChainDelta: -1, ambientDelta: -1 },
    { id: "late_freighter", name: "末班货轮", description: "冷链货价 +1，常温货价 +1", coldChainDelta: 1, ambientDelta: 1 }
  ],
  achievements: [
    { id: "empty_inventory", name: "空仓主义", description: "游戏结束时普通库存为0。", kind: "empty_inventory", bonus: 3 },
    { id: "five_distinct", name: "分散投资", description: "曾同时持有至少5种不同普通商品。", kind: "five_distinct", bonus: 3 },
    { id: "four_same", name: "重仓玩家", description: "曾同时持有同一种普通商品至少4件。", kind: "four_same", bonus: 3 },
    { id: "three_orders_one_round", name: "周转大师", description: "同一轮内完成至少3张航运委托。", kind: "three_orders_one_round", bonus: 3 },
    { id: "three_cross_round_items", name: "跨轮投资", description: "至少3件较早轮次购买的商品在后续轮次用于核销。", kind: "three_cross_round_items", bonus: 3 },
    { id: "precise_round_three", name: "精准采购", description: "第三轮购买的全部普通商品都在终局前用于核销。", kind: "precise_round_three", bonus: 3 },
    { id: "inspection_both_early_rounds", name: "特殊渠道", description: "第一、第二轮都购买过海关查验货。", kind: "inspection_both_early_rounds", bonus: 3 },
    { id: "never_inspection", name: "规避查验", description: "整局从未购买任何海关查验货。", kind: "never_inspection", bonus: 3 },
    { id: "two_large_orders", name: "大宗贸易", description: "完成至少2张四件商品航运委托。", kind: "two_large_orders", bonus: 3 },
    { id: "three_small_orders", name: "小单高手", description: "完成至少3张两件商品航运委托。", kind: "three_small_orders", bonus: 3 }
  ]
};

export function mergeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}
