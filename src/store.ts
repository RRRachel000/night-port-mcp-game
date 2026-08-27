import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GameRuleError, NightPortGame, type CreateGameInput } from "./engine.js";
import type { GameSnapshot } from "./types.js";

function safeFileName(gameId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(gameId)) {
    throw new GameRuleError(
      "INVALID_GAME_ID",
      "gameId may only contain letters, numbers, underscores, and hyphens."
    );
  }
  return `${gameId}.json`;
}

export class GameStore {
  private readonly directory: string;
  private readonly games = new Map<string, NightPortGame>();

  constructor(directory = process.env.NIGHT_PORT_DATA_DIR ?? resolve("data", "games")) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true });
  }

  create(input: CreateGameInput): { game: NightPortGame; playerToken: string } {
    const created = NightPortGame.create(input);
    const path = this.pathFor(created.game.id);
    if (existsSync(path)) {
      throw new GameRuleError("GAME_ID_EXISTS", `Game '${created.game.id}' already exists.`);
    }
    this.games.set(created.game.id, created.game);
    this.save(created.game);
    return created;
  }

  get(gameId: string): NightPortGame {
    const cached = this.games.get(gameId);
    if (cached !== undefined) return cached;
    const path = this.pathFor(gameId);
    if (!existsSync(path)) {
      throw new GameRuleError("GAME_NOT_FOUND", `Game '${gameId}' was not found.`);
    }
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as GameSnapshot;
    const game = NightPortGame.fromSnapshot(snapshot);
    this.games.set(gameId, game);
    return game;
  }

  save(game: NightPortGame): void {
    const target = this.pathFor(game.id);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(game.exportSnapshot(), null, 2)}\n`, "utf8");
    renameSync(temporary, target);
  }

  listGameIds(): string[] {
    const diskIds = readdirSync(this.directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
    return [...new Set([...diskIds, ...this.games.keys()])].sort();
  }

  private pathFor(gameId: string): string {
    return resolve(this.directory, safeFileName(gameId));
  }
}

