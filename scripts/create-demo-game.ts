import { GameStore } from "../src/store.js";

const store = new GameStore();
const gameId = process.env.NIGHT_PORT_DEMO_GAME_ID ?? "night-port-demo";
const tokens = { a: "demo-a", b: "demo-b", c: "demo-c" } as const;

let game;
try {
  const created = store.create({
    gameId,
    creatorId: "a",
    creatorName: "海岬商会",
    creatorType: "ai",
    creatorToken: tokens.a,
    seed: "night-port-demo-seed"
  });
  game = created.game;
} catch (error) {
  if (error instanceof Error && error.message.includes("already exists")) {
    process.stdout.write(`Demo game '${gameId}' already exists.\n`);
    process.exit(0);
  }
  throw error;
}

game.joinPlayer({
  playerId: "b",
  playerName: "北斗行栈",
  controllerType: "ai",
  playerToken: tokens.b,
  expectedStateVersion: game.stateVersion
});
game.joinPlayer({
  playerId: "c",
  playerName: "灯塔贸易",
  controllerType: "human",
  playerToken: tokens.c,
  expectedStateVersion: game.stateVersion
});
game.startGame({ playerId: "a", playerToken: tokens.a, expectedStateVersion: game.stateVersion });
for (const playerId of ["a", "b", "c"] as const) {
  const state = game.privateState({ playerId, playerToken: tokens[playerId] });
  const candidates = state.achievementCandidates as Array<{ id: string }>;
  game.chooseAchievement({
    playerId,
    playerToken: tokens[playerId],
    achievementId: candidates[0]!.id,
    expectedStateVersion: game.stateVersion
  });
}

for (const purchaseCount of [2, 1]) {
  const state = game.publicState();
  const currentPlayer = state.currentPlayer as keyof typeof tokens;
  const positions = (state.market as Array<{ position: number; occupied: boolean; inspectionCargo: boolean }>)
    .filter((slot) => slot.occupied && !slot.inspectionCargo)
    .slice(0, purchaseCount)
    .map((slot) => slot.position);
  game.takeTurn({
    playerId: currentPlayer,
    playerToken: tokens[currentPlayer],
    expectedStateVersion: game.stateVersion,
    action: { marketPositions: positions }
  });
}

const state = game.publicState();
const currentPlayer = state.currentPlayer as keyof typeof tokens;
game.takeTurn({
  playerId: currentPlayer,
  playerToken: tokens[currentPlayer],
  expectedStateVersion: game.stateVersion,
  action: {}
});
store.save(game);

process.stdout.write(`${JSON.stringify({
  ok: true,
  gameId,
  stateVersion: game.stateVersion,
  phase: game.publicState().phase
}, null, 2)}\n`);
