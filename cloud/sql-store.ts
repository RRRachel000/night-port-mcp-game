import { GameRuleError, NightPortGame, type CreateGameInput } from "../src/engine.js";
import type { GameRepository } from "../src/game-repository.js";
import type { GameSnapshot } from "../src/types.js";
import { emptyWindowControl, type WindowControl } from "../src/window-types.js";

export interface SqlAdapter {
  exec(query: string, ...bindings: (string | number | null)[]): { toArray(): Record<string, unknown>[] };
}
type StoredSnapshot = GameSnapshot & { windowControl?: WindowControl };

export class SqlGameStore implements GameRepository {
  constructor(private readonly sql: SqlAdapter) {
    sql.exec("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)");
  }
  private validateId(id: string): void {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new GameRuleError("INVALID_GAME_ID", "Invalid game ID.");
  }
  private read(id: string): StoredSnapshot {
    this.validateId(id);
    const row = this.sql.exec("SELECT snapshot FROM games WHERE id = ?", id).toArray()[0];
    if (!row) throw new GameRuleError("GAME_NOT_FOUND", "Game was not found.");
    return JSON.parse(String(row.snapshot)) as StoredSnapshot;
  }
  create(input: CreateGameInput): { game: NightPortGame; playerToken: string } {
    const created = NightPortGame.create(input);
    this.validateId(created.game.id);
    if (this.sql.exec("SELECT id FROM games WHERE id = ?", created.game.id).toArray().length) {
      throw new GameRuleError("GAME_ID_EXISTS", "Game ID already exists.");
    }
    this.sql.exec("INSERT INTO games (id, snapshot) VALUES (?, ?)", created.game.id, JSON.stringify(created.game.exportSnapshot()));
    return created;
  }
  get(id: string): NightPortGame {
    const { windowControl: _control, ...snapshot } = this.read(id);
    return NightPortGame.fromSnapshot(snapshot);
  }
  save(game: NightPortGame): void {
    const control = this.windowControl(game.id);
    this.persist(game, control);
  }
  windowControl(id: string): WindowControl | undefined { return this.read(id).windowControl; }
  transaction<T>(id: string, operation: (game: NightPortGame, control: WindowControl) => T): T {
    const previous = this.read(id);
    const { windowControl, ...snapshot } = previous;
    const game = NightPortGame.fromSnapshot(snapshot);
    const control = structuredClone(windowControl ?? emptyWindowControl());
    const result = operation(game, control);
    this.persist(game, windowControl || control.routes.length || control.jobs.length ? control : undefined);
    return result;
  }
  private persist(game: NightPortGame, control?: WindowControl): void {
    const snapshot: StoredSnapshot = { ...game.exportSnapshot(), ...(control ? { windowControl: control } : {}) };
    // One SQL statement atomically commits game state, notification jobs and replay receipts.
    this.sql.exec("UPDATE games SET snapshot = ? WHERE id = ?", JSON.stringify(snapshot), game.id);
  }
  listGameIds(): string[] { return this.sql.exec("SELECT id FROM games ORDER BY id").toArray().map(row => String(row.id)); }
  exportSnapshot(id: string): StoredSnapshot { return this.read(id); }
  importSnapshot(snapshot: StoredSnapshot): { id: string; stateVersion: number; imported: boolean } {
    this.validateId(snapshot.id);
    const { windowControl, ...gameSnapshot } = snapshot;
    const game = NightPortGame.fromSnapshot(gameSnapshot);
    if (windowControl && windowControl.schemaVersion !== 1) throw new GameRuleError("INVALID_SNAPSHOT", "Unsupported control schema.");
    const existing = this.sql.exec("SELECT snapshot FROM games WHERE id = ?", snapshot.id).toArray()[0];
    if (existing) {
      if (JSON.stringify(JSON.parse(String(existing.snapshot))) === JSON.stringify(snapshot)) return { id: snapshot.id, stateVersion: game.stateVersion, imported: false };
      throw new GameRuleError("GAME_ID_EXISTS", "Import never overwrites an existing game.");
    }
    this.sql.exec("INSERT INTO games (id, snapshot) VALUES (?, ?)", snapshot.id, JSON.stringify(snapshot));
    return { id: snapshot.id, stateVersion: game.stateVersion, imported: true };
  }
}
