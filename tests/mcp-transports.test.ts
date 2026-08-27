import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { createAuthoritativeServer } from "../src/authoritative-server.js";
import { GameStore } from "../src/store.js";

interface ToolResponse {
  content: Array<{ type: string; text?: string }>;
}

function payloadOf(response: ToolResponse): Record<string, unknown> {
  const text = response.content.find((entry) => entry.type === "text");
  if (text?.text === undefined) throw new Error("MCP response had no text payload.");
  return JSON.parse(text.text) as Record<string, unknown>;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return payloadOf(await client.callTool({ name, arguments: args }) as ToolResponse);
}

test("Streamable HTTP 与 STDIO 代理共享唯一 GameStore，并隔离玩家 token", async () => {
  const root = resolve(import.meta.dirname, "..");
  const dataDirectory = mkdtempSync(join(tmpdir(), "night-port-dual-transport-"));
  const store = new GameStore(dataDirectory);
  const runtime = createAuthoritativeServer(store);
  const chatgpt = new Client({ name: "chatgpt-player", version: "0.1.0" });
  const codex = new Client({ name: "codex-player", version: "0.1.0" });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      runtime.server.once("error", rejectListen);
      runtime.server.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = runtime.server.address();
    assert.ok(address !== null && typeof address === "object");
    const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

    const chatgptTransport = new StreamableHTTPClientTransport(new URL(mcpUrl));
    const codexTransport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/mcp-server.ts"],
      cwd: root,
      env: { ...getDefaultEnvironment(), NIGHT_PORT_MCP_URL: mcpUrl },
      stderr: "pipe"
    });
    await Promise.all([
      chatgpt.connect(chatgptTransport),
      codex.connect(codexTransport)
    ]);

    const [chatgptTools, codexTools] = await Promise.all([
      chatgpt.listTools(),
      codex.listTools()
    ]);
    assert.deepEqual(
      codexTools.tools.map((tool) => tool.name).sort(),
      chatgptTools.tools.map((tool) => tool.name).sort()
    );

    const created = await call(chatgpt, "create_game", {
      gameId: "dual-transport",
      creatorId: "chatgpt",
      creatorName: "ChatGPT",
      controllerType: "ai",
      seed: "dual-transport"
    });
    assert.equal(created.ok, true);
    const chatgptToken = created.playerToken as string;
    let stateVersion = created.stateVersion as number;

    const codexJoined = await call(codex, "join_game", {
      gameId: "dual-transport",
      playerId: "codex",
      playerName: "Codex",
      controllerType: "ai",
      expectedStateVersion: stateVersion
    });
    assert.equal(codexJoined.ok, true);
    const codexToken = codexJoined.playerToken as string;
    stateVersion = codexJoined.stateVersion as number;
    assert.notEqual(chatgptToken, codexToken);

    const thirdJoined = await call(chatgpt, "join_game", {
      gameId: "dual-transport",
      playerId: "harbor-bot",
      playerName: "Harbor Bot",
      controllerType: "ai",
      expectedStateVersion: stateVersion
    });
    const thirdToken = thirdJoined.playerToken as string;
    stateVersion = thirdJoined.stateVersion as number;

    const started = await call(chatgpt, "start_game", {
      gameId: "dual-transport",
      playerId: "chatgpt",
      playerToken: chatgptToken,
      expectedStateVersion: stateVersion
    });
    assert.equal(started.ok, true);
    stateVersion = started.stateVersion as number;

    const [chatgptPrivate, codexPrivate] = await Promise.all([
      call(chatgpt, "private_state", {
        gameId: "dual-transport",
        playerId: "chatgpt",
        playerToken: chatgptToken
      }),
      call(codex, "private_state", {
        gameId: "dual-transport",
        playerId: "codex",
        playerToken: codexToken
      })
    ]);
    assert.equal(chatgptPrivate.playerId, "chatgpt");
    assert.equal(codexPrivate.playerId, "codex");

    const [chatgptCrossRead, codexCrossRead] = await Promise.all([
      call(chatgpt, "private_state", {
        gameId: "dual-transport",
        playerId: "codex",
        playerToken: chatgptToken
      }),
      call(codex, "private_state", {
        gameId: "dual-transport",
        playerId: "chatgpt",
        playerToken: codexToken
      })
    ]);
    assert.equal((chatgptCrossRead.error as { code: string }).code, "PLAYER_AUTH_FAILED");
    assert.equal((codexCrossRead.error as { code: string }).code, "PLAYER_AUTH_FAILED");

    const chatgptAchievement = (chatgptPrivate.achievementCandidates as Array<{ id: string }>)[0]!.id;
    const codexAchievement = (codexPrivate.achievementCandidates as Array<{ id: string }>)[0]!.id;
    const concurrentChoices = await Promise.all([
      call(chatgpt, "choose_achievement", {
        gameId: "dual-transport",
        playerId: "chatgpt",
        playerToken: chatgptToken,
        achievementId: chatgptAchievement,
        expectedStateVersion: stateVersion
      }),
      call(codex, "choose_achievement", {
        gameId: "dual-transport",
        playerId: "codex",
        playerToken: codexToken,
        achievementId: codexAchievement,
        expectedStateVersion: stateVersion
      })
    ]);
    const successes = concurrentChoices.filter((choice) => choice.ok === true);
    const conflicts = concurrentChoices.filter(
      (choice) => (choice.error as { code?: string } | undefined)?.code === "STATE_VERSION_CONFLICT"
    );
    assert.equal(successes.length, 1);
    assert.equal(conflicts.length, 1);

    const afterConflict = await call(chatgpt, "game_state", { gameId: "dual-transport" });
    stateVersion = afterConflict.stateVersion as number;
    const loserIndex = concurrentChoices[0]!.ok === true ? 1 : 0;
    const retryClient = loserIndex === 0 ? chatgpt : codex;
    const retryPlayerId = loserIndex === 0 ? "chatgpt" : "codex";
    const retryToken = loserIndex === 0 ? chatgptToken : codexToken;
    const retryAchievement = loserIndex === 0 ? chatgptAchievement : codexAchievement;
    const retried = await call(retryClient, "choose_achievement", {
      gameId: "dual-transport",
      playerId: retryPlayerId,
      playerToken: retryToken,
      achievementId: retryAchievement,
      expectedStateVersion: stateVersion
    });
    assert.equal(retried.ok, true);
    stateVersion = retried.stateVersion as number;

    const thirdPrivate = await call(chatgpt, "private_state", {
      gameId: "dual-transport",
      playerId: "harbor-bot",
      playerToken: thirdToken
    });
    const thirdAchievement = (thirdPrivate.achievementCandidates as Array<{ id: string }>)[0]!.id;
    const thirdChosen = await call(chatgpt, "choose_achievement", {
      gameId: "dual-transport",
      playerId: "harbor-bot",
      playerToken: thirdToken,
      achievementId: thirdAchievement,
      expectedStateVersion: stateVersion
    });
    assert.equal(thirdChosen.phase, "active");

    const [httpState, stdioState, webResponse] = await Promise.all([
      call(chatgpt, "game_state", { gameId: "dual-transport" }),
      call(codex, "game_state", { gameId: "dual-transport" }),
      fetch(`http://127.0.0.1:${address.port}/api/games/dual-transport`)
    ]);
    const webState = await webResponse.json() as Record<string, unknown>;
    assert.equal(httpState.stateVersion, stdioState.stateVersion);
    assert.equal(httpState.stateVersion, webState.stateVersion);
    assert.equal(httpState.phase, "active");
    assert.deepEqual(store.listGameIds(), ["dual-transport"]);
  } finally {
    await Promise.all([
      chatgpt.close().catch(() => undefined),
      codex.close().catch(() => undefined)
    ]);
    await runtime.mcpHandler.close().catch(() => undefined);
    await new Promise<void>((resolveClose) => runtime.server.close(() => resolveClose()));
    rmSync(dataDirectory, { recursive: true, force: true });
  }
});
