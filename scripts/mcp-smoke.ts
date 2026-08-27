import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createAuthoritativeServer } from "../src/authoritative-server.js";
import { GameStore } from "../src/store.js";

function payloadOf(response: { content: Array<{ type: string; text?: string }> }): Record<string, unknown> {
  const text = response.content.find((entry) => entry.type === "text");
  if (text?.text === undefined) throw new Error("MCP response had no text payload.");
  return JSON.parse(text.text) as Record<string, unknown>;
}

const root = resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "night-port-mcp-smoke-"));
const runtime = createAuthoritativeServer(new GameStore(dataDir));
await new Promise<void>((resolveListen, rejectListen) => {
  runtime.server.once("error", rejectListen);
  runtime.server.listen(0, "127.0.0.1", () => resolveListen());
});
const address = runtime.server.address();
assert.ok(address !== null && typeof address === "object");
const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/mcp-server.ts"],
  cwd: root,
  env: { ...getDefaultEnvironment(), NIGHT_PORT_MCP_URL: mcpUrl },
  stderr: "pipe"
});
const client = new Client({ name: "night-port-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const toolNames = (listed.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, [
    "choose_achievement",
    "create_game",
    "game_log",
    "game_state",
    "join_game",
    "private_state",
    "start_game",
    "take_turn",
    "vote_carryover"
  ]);

  const created = payloadOf(await client.callTool({
    name: "create_game",
    arguments: {
      gameId: "smoke-game",
      creatorId: "a",
      creatorName: "A",
      controllerType: "ai",
      seed: "smoke"
    }
  }));
  assert.equal(created.ok, true);
  const tokens: Record<string, string> = { a: created.playerToken as string };
  let stateVersion = created.stateVersion as number;

  for (const playerId of ["b", "c"]) {
    const joined = payloadOf(await client.callTool({
      name: "join_game",
      arguments: {
        gameId: "smoke-game",
        playerId,
        playerName: playerId.toUpperCase(),
        controllerType: "ai",
        expectedStateVersion: stateVersion
      }
    }));
    assert.equal(joined.ok, true);
    tokens[playerId] = joined.playerToken as string;
    stateVersion = joined.stateVersion as number;
  }

  const started = payloadOf(await client.callTool({
    name: "start_game",
    arguments: {
      gameId: "smoke-game",
      playerId: "a",
      playerToken: tokens.a,
      expectedStateVersion: stateVersion
    }
  }));
  assert.equal(started.ok, true);
  stateVersion = started.stateVersion as number;

  for (const playerId of ["a", "b", "c"]) {
    const privateState = payloadOf(await client.callTool({
      name: "private_state",
      arguments: { gameId: "smoke-game", playerId, playerToken: tokens[playerId] }
    }));
    const candidates = privateState.achievementCandidates as Array<{ id: string }>;
    assert.equal(candidates.length, 3);
    const chosen = payloadOf(await client.callTool({
      name: "choose_achievement",
      arguments: {
        gameId: "smoke-game",
        playerId,
        playerToken: tokens[playerId],
        achievementId: candidates[0]!.id,
        expectedStateVersion: stateVersion
      }
    }));
    assert.equal(chosen.ok, true);
    stateVersion = chosen.stateVersion as number;
  }

  const publicState = payloadOf(await client.callTool({
    name: "game_state",
    arguments: { gameId: "smoke-game", includeProfitEstimates: true }
  }));
  assert.equal(publicState.ok, true);
  assert.equal(publicState.phase, "active");
  assert.equal((publicState.market as unknown[]).length, 18);
  assert.equal(JSON.stringify(publicState).includes("chosenAchievement"), false);
  const currentPlayer = publicState.currentPlayer as string;

  const acted = payloadOf(await client.callTool({
    name: "take_turn",
    arguments: {
      gameId: "smoke-game",
      playerId: currentPlayer,
      playerToken: tokens[currentPlayer],
      expectedStateVersion: publicState.stateVersion,
      marketPositions: []
    }
  }));
  assert.equal(acted.ok, true);
  assert.equal(acted.wasPass, true);

  const log = payloadOf(await client.callTool({
    name: "game_log",
    arguments: { gameId: "smoke-game", offset: 0, limit: 200 }
  }));
  assert.equal(log.ok, true);
  assert.ok((log.total as number) >= 8);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    tools: toolNames.length,
    phase: publicState.phase,
    marketSlots: (publicState.market as unknown[]).length,
    logEntries: log.total
  }, null, 2)}\n`);
} finally {
  await client.close().catch(() => undefined);
  await runtime.mcpHandler.close().catch(() => undefined);
  await new Promise<void>((resolveClose) => runtime.server.close(() => resolveClose()));
  rmSync(dataDir, { recursive: true, force: true });
}
