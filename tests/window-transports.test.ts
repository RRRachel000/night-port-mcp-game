import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";

import { createAuthoritativeServer } from "../src/authoritative-server.js";
import { GameStore } from "../src/store.js";

const execFileAsync = promisify(execFile);

test("operator dispatcher and three isolated MCP seat clients finish an autonomous match", async () => {
  const directory = mkdtempSync(join(tmpdir(), "night-port-window-http-"));
  const store = new GameStore(directory);
  const { game } = store.create({ gameId: "http-match", creatorId: "a", creatorName: "A", creatorType: "ai", seed: "http" });
  for (const id of ["b", "c"]) game.joinPlayer({ playerId: id, playerName: id, controllerType: "ai", expectedStateVersion: game.stateVersion });
  store.save(game);
  const operatorKey = "test-operator-secret";
  const runtime = createAuthoritativeServer(store, { operatorKey });
  const clients = new Map<string, Client>();
  try {
    await new Promise<void>(done => runtime.server.listen(0, "127.0.0.1", done));
    const address = runtime.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const control = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/referee`, { method: "POST", headers: { authorization: `Bearer ${operatorKey}` }, body: JSON.stringify({ gameId: "http-match", ...body }) });
      assert.equal(response.status, 200);
      return (await response.json() as { result: any }).result;
    };
    const anonymous = await fetch(`${base}/api/referee`, { method: "POST", body: JSON.stringify({ operation: "claim", gameId: "http-match" }) });
    assert.equal(anonymous.status, 401);
    const seatKeys: string[] = [];
    for (const id of ["a", "b", "c"]) {
      const binding = await control({ operation: "bind", route: { playerId: id, threadId: `window-${id}`, hostId: "local", kind: "codex" } });
      seatKeys.push(binding.key);
      const client = new Client({ name: `window-${id}`, version: "test" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/seat/${binding.key}`)));
      clients.set(id, client);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["my_state", "submit_action"]);
      const mine = (await client.callTool({ name: "my_state", arguments: {} })).structuredContent as any;
      assert.equal(mine.playerId, id);
      assert.equal(JSON.stringify(mine).includes(binding.key), false);
      assert.equal(JSON.stringify(mine).includes('"token"'), false);
    }
    for (let step = 0; step < 100; step++) {
      const { task, runtime: status } = await control({ operation: "claim" });
      if (!task) { assert.equal(status.status, "finished"); break; }
      const client = clients.get(task.playerId)!;
      await control({ operation: "report", jobId: task.jobId, dispatchId: task.dispatchId });
      const mine = (await client.callTool({ name: "my_state", arguments: {} })).structuredContent as any;
      assert.equal(mine.task.actionId, task.jobId);
      let action;
      switch (mine.task.actionType) {
        case "start": action = { type: "start" }; break;
        case "choose_achievement": action = { type: "choose_achievement", achievementId: mine.privateState.achievementCandidates[0].id }; break;
        case "vote_carryover": action = { type: "vote_carryover", approve: true }; break;
        default: action = { type: "take_turn", marketPositions: [] };
      }
      const args = { actionId: mine.task.actionId, expectedStateVersion: mine.task.expectedStateVersion, action };
      const submitted = await client.callTool({ name: "submit_action", arguments: args });
      assert.equal(submitted.isError, undefined);
      const retried = (await client.callTool({ name: "submit_action", arguments: args })).structuredContent as any;
      assert.equal(retried.replayed, true);
      const publicResponse = JSON.stringify(await (await fetch(`${base}/api/games/http-match`)).json());
      for (const key of seatKeys) assert.equal(publicResponse.includes(key), false);
      assert.equal(publicResponse.includes("window-a"), false);
    }
    assert.equal(store.get("http-match").publicState().phase, "finished");
    assert.equal((await control({ operation: "status" })).status, "finished");
  } finally {
    await Promise.all([...clients.values()].map(client => client.close().catch(() => undefined)));
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("existing Codex window CLI and STDIO connection recover their seat without exposing credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "night-port-player-cli-"));
  const store = new GameStore(join(directory, "games"));
  const { game } = store.create({ gameId: "cli-match", creatorId: "a", creatorName: "A", creatorType: "ai" });
  for (const id of ["b", "c"]) game.joinPlayer({ playerId: id, playerName: id, controllerType: "ai", expectedStateVersion: game.stateVersion });
  store.save(game);
  const operatorKey = "cli-operator-key";
  const keyFile = join(directory, "operator.key");
  writeFileSync(keyFile, operatorKey);
  const runtime = createAuthoritativeServer(store, { operatorKey });
  const proxy = new Client({ name: "seat-proxy-test", version: "test" });
  try {
    await new Promise<void>(done => runtime.server.listen(0, "127.0.0.1", done));
    const address = runtime.server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const root = resolve(import.meta.dirname, "..");
    const nodeArgs = ["--import", import.meta.resolve("tsx")];
    const bound = await execFileAsync(process.execPath, [...nodeArgs, join(root, "scripts/window-referee.ts"), "bind", "--game", "cli-match", "--player", "a", "--thread", "existing-codex-window"], {
      cwd: directory, env: { ...process.env, NIGHT_PORT_LOCAL_URL: base, NIGHT_PORT_OPERATOR_KEY_FILE: keyFile }
    });
    const result = JSON.parse(bound.stdout);
    assert.equal(bound.stdout.includes("/mcp/seat/"), false);
    assert.equal(bound.stdout.includes(operatorKey), false);
    const connection = JSON.parse(readFileSync(result.connectionFile, "utf8"));
    const state = await execFileAsync(process.execPath, [...nodeArgs, join(root, "scripts/window-player.ts"), "state", "--connection-file", result.connectionFile], { cwd: directory });
    const mine = JSON.parse(state.stdout);
    assert.equal(mine.playerId, "a");
    assert.equal(state.stdout.includes(connection.localMcpUrl), false);
    await proxy.connect(new StdioClientTransport({ command: process.execPath, args: [...nodeArgs, join(root, "src/mcp-server.ts")], cwd: root,
      env: { ...getDefaultEnvironment(), NIGHT_PORT_CONNECTION_FILE: result.connectionFile }, stderr: "pipe" }));
    assert.deepEqual((await proxy.listTools()).tools.map(tool => tool.name).sort(), ["my_state", "submit_action"]);
    const file = join(directory, "action.json");
    writeFileSync(file, JSON.stringify({ actionId: mine.task.actionId, expectedStateVersion: mine.task.expectedStateVersion, action: { type: "start" } }));
    const action = await execFileAsync(process.execPath, [...nodeArgs, join(root, "scripts/window-player.ts"), "submit", "--connection-file", result.connectionFile, "--action-file", file], { cwd: directory });
    assert.equal(JSON.parse(action.stdout).ok, true);
    const retry = await execFileAsync(process.execPath, [...nodeArgs, join(root, "scripts/window-player.ts"), "submit", "--connection-file", result.connectionFile, "--action-file", file], { cwd: directory });
    assert.equal(JSON.parse(retry.stdout).replayed, true);
    // An already connected old MCP client must also lose access after takeover.
    runtime.coordinator.bind("cli-match", { playerId: "a", threadId: "new-window", hostId: "local", kind: "codex" }, true);
    const revoked = await fetch(connection.localMcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(revoked.status, 401);
  } finally {
    await proxy.close().catch(() => undefined);
    await runtime.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
