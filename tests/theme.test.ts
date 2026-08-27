import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_CONFIG } from "../src/config.js";
import { GameStore } from "../src/store.js";
import { createWebServer } from "../src/web-server.js";

const FORBIDDEN_PUBLIC_THEME = /茄子|辣椒|青菜|芒果|菠萝|西瓜|水果价|蔬菜价/;
const TOKENS = { a: "theme-token-a", b: "theme-token-b", c: "theme-token-c" } as const;

function startThemeGame(store: GameStore, gameId: string) {
  const created = store.create({
    gameId,
    creatorId: "a",
    creatorName: "A",
    creatorType: "ai",
    creatorToken: TOKENS.a,
    seed: "port-theme-regression"
  });
  const game = created.game;
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
  for (const playerId of ["a", "b", "c"] as const) {
    const privateState = game.privateState({ playerId, playerToken: TOKENS[playerId] });
    const candidates = privateState.achievementCandidates as Array<{ id: string }>;
    game.chooseAchievement({
      playerId,
      playerToken: TOKENS[playerId],
      achievementId: candidates[0]!.id,
      expectedStateVersion: game.stateVersion
    });
  }
  store.save(game);
  return game;
}

test("23 港口商品映射保持18张航运委托的材料拓扑与酬劳", () => {
  assert.deepEqual(
    DEFAULT_CONFIG.commodities.map(({ id, name, category, basePrice }) => ({ id, name, category, basePrice })),
    [
      { id: "seafood", name: "海产", category: "cold_chain", basePrice: 4 },
      { id: "flowers", name: "鲜花", category: "cold_chain", basePrice: 4 },
      { id: "tropical_fruit", name: "热带果", category: "cold_chain", basePrice: 4 },
      { id: "tea", name: "茶叶", category: "ambient", basePrice: 2 },
      { id: "spices", name: "香料", category: "ambient", basePrice: 2 },
      { id: "timber", name: "木料", category: "ambient", basePrice: 2 }
    ]
  );
  assert.deepEqual(
    DEFAULT_CONFIG.orders.map(({ requirements, reward }) => ({ requirements, reward })),
    [
      { requirements: ["tea", "spices"], reward: 8 },
      { requirements: ["spices", "flowers"], reward: 11 },
      { requirements: ["spices", "seafood"], reward: 11 },
      { requirements: ["timber", "flowers"], reward: 11 },
      { requirements: ["seafood", "timber"], reward: 11 },
      { requirements: ["flowers", "tropical_fruit"], reward: 14 },
      { requirements: ["tea", "timber", "tropical_fruit"], reward: 15 },
      { requirements: ["tea", "spices", "seafood"], reward: 15 },
      { requirements: ["timber", "flowers", "tropical_fruit"], reward: 18 },
      { requirements: ["tea", "seafood", "tropical_fruit"], reward: 18 },
      { requirements: ["tea", "flowers", "tropical_fruit"], reward: 18 },
      { requirements: ["spices", "seafood", "flowers"], reward: 18 },
      { requirements: ["tea", "spices", "timber", "tropical_fruit"], reward: 19 },
      { requirements: ["tea", "spices", "seafood", "timber"], reward: 19 },
      { requirements: ["tea", "spices", "flowers", "tropical_fruit"], reward: 22 },
      { requirements: ["spices", "seafood", "timber", "flowers"], reward: 22 },
      { requirements: ["tea", "seafood", "timber", "tropical_fruit"], reward: 22 },
      { requirements: ["seafood", "timber", "flowers", "tropical_fruit"], reward: 27 }
    ]
  );
});

test("24 game_state、game_log和Web API公开内容不再泄漏原型主题词", async () => {
  const directory = mkdtempSync(join(tmpdir(), "night-port-theme-"));
  const store = new GameStore(directory);
  const game = startThemeGame(store, "theme-api-test");
  const server = createWebServer(store);

  try {
    const enginePayload = JSON.stringify({
      gameState: game.publicState({ includeProfitEstimates: true }),
      gameLog: game.fullLog()
    });
    assert.equal(FORBIDDEN_PUBLIC_THEME.test(enginePayload), false);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [stateResponse, logResponse] = await Promise.all([
      fetch(`${baseUrl}/api/games/theme-api-test`),
      fetch(`${baseUrl}/api/games/theme-api-test/log`)
    ]);
    assert.equal(stateResponse.status, 200);
    assert.equal(logResponse.status, 200);
    const webPayload = `${await stateResponse.text()}\n${await logResponse.text()}`;
    assert.equal(FORBIDDEN_PUBLIC_THEME.test(webPayload), false);
    assert.match(webPayload, /冷链货价|常温货价|海关查验货|货运市场|航运委托/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
