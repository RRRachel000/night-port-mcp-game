import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { GameRuleError, NightPortGame, type CreateGameInput } from "./engine.js";
import type { GameSnapshot } from "./types.js";
import { emptyWindowControl, type WindowControl } from "./window-types.js";

interface StoredSnapshot extends GameSnapshot {
  windowControl?: WindowControl;
}

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
  private readonly controls = new Map<string, WindowControl>();

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
    const { windowControl, ...snapshot } = JSON.parse(readFileSync(path, "utf8")) as StoredSnapshot;
    const game = NightPortGame.fromSnapshot(snapshot);
    if (windowControl !== undefined) {
      if (windowControl.schemaVersion !== 1) throw new Error("Unsupported window control schema.");
      this.controls.set(gameId, windowControl);
    }
    this.games.set(gameId, game);
    return game;
  }

  save(game: NightPortGame): void {
    this.persist(game, this.controls.get(game.id));
    this.games.set(game.id, game);
  }

  windowControl(gameId: string): WindowControl | undefined {
    this.get(gameId);
    const control = this.controls.get(gameId);
    return control === undefined ? undefined : structuredClone(control);
  }

  /** Publish the new in-memory state only after its game, jobs and receipts reach disk together. */
  transaction<T>(gameId: string, operation: (game: NightPortGame, control: WindowControl) => T): T {
    const original = this.get(gameId);
    const game = NightPortGame.fromSnapshot(original.exportSnapshot(), original.config);
    const previous = this.controls.get(gameId);
    const control = structuredClone(previous ?? emptyWindowControl());
    const output = operation(game, control);
    const changedControl = previous !== undefined || control.routes.length > 0 || control.jobs.length > 0;
    this.persist(game, changedControl ? control : undefined);
    this.games.set(gameId, game);
    if (changedControl) this.controls.set(gameId, control);
    return output;
  }

  protected persist(game: NightPortGame, control?: WindowControl): void {
    const target = this.pathFor(game.id);
    const temporary = `${target}.tmp`;
    const snapshot: StoredSnapshot = { ...game.exportSnapshot(), ...(control === undefined ? {} : { windowControl: control }) };
    writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
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
