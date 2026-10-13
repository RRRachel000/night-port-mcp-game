import type { CreateGameInput, NightPortGame } from "./engine.js";
import type { WindowControl } from "./window-types.js";

/** One synchronous, atomic persistence boundary shared by local and cloud transports. */
export interface GameRepository {
  create(input: CreateGameInput): { game: NightPortGame; playerToken: string };
  get(gameId: string): NightPortGame;
  save(game: NightPortGame): void;
  windowControl(gameId: string): WindowControl | undefined;
  transaction<T>(gameId: string, operation: (game: NightPortGame, control: WindowControl) => T): T;
  listGameIds(): string[];
}
