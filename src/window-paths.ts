import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function playerConnectionFile(gameId: string, playerId: string): string {
  const name = createHash("sha256").update(`${gameId}\0${playerId}`).digest("hex").slice(0, 24);
  return resolve(".local", "players", `${name}.json`);
}
