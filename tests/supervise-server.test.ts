import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

test("supervisor restores the same match, seat connection and notification lease after a real process crash", { timeout: 30_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "night-port-supervisor-"));
  const games = join(directory, "games");
  const keyFile = join(directory, "operator.key");
  const ownerFile = join(games, ".authority-lock", "owner.json");
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(done => probe.close(() => done()));
  const root = resolve(import.meta.dirname, "..");
  const supervisor = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), join(root, "scripts/supervise-server.ts")], {
    cwd: root, env: { ...process.env, NIGHT_PORT_DATA_DIR: games, NIGHT_PORT_OPERATOR_KEY_FILE: keyFile, NIGHT_PORT_PORT: String(port), NIGHT_PORT_HOST: "127.0.0.1" },
    stdio: "ignore", windowsHide: true
  });
  const ownedPids = new Set<number>();
  const base = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  const owner = () => JSON.parse(readFileSync(ownerFile, "utf8")) as { pid: number };
  const waitForAuthority = async (previous?: number) => {
    for (let i = 0; i < 160; i++) {
      if (existsSync(ownerFile)) {
        const current = owner().pid;
        ownedPids.add(current);
        if (current !== previous) {
          try { if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(300) })).ok) return current; } catch { /* retry startup */ }
        }
      }
      await delay(75);
    }
    throw new Error("Isolated authority did not recover within the test deadline.");
  };
  try {
    const firstPid = await waitForAuthority();
    const client = new Client({ name: "supervisor-test", version: "test" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any;
    const created = await call("create_game", { gameId: "restart-match", creatorId: "a", creatorName: "A", controllerType: "ai" });
    let version = created.stateVersion;
    for (const id of ["b", "c"]) version = (await call("join_game", { gameId: "restart-match", playerId: id, playerName: id, controllerType: "ai", expectedStateVersion: version })).stateVersion;
    const operatorKey = readFileSync(keyFile, "utf8").trim();
    const control = async (body: Record<string, unknown>) => {
      const response = await fetch(`${base}/api/referee`, { method: "POST", headers: { authorization: `Bearer ${operatorKey}` }, body: JSON.stringify({ gameId: "restart-match", ...body }) });
      assert.equal(response.status, 200);
      return (await response.json() as any).result;
    };
    const binding = await control({ operation: "bind", route: { playerId: "a", threadId: "original-window", hostId: "local", kind: "codex" } });
    const dispatched = (await control({ operation: "claim" })).task;
    await control({ operation: "report", jobId: dispatched.jobId, dispatchId: dispatched.dispatchId });
    await client.close();
    process.kill(firstPid, "SIGKILL");
    const secondPid = await waitForAuthority(firstPid);
    assert.notEqual(secondPid, firstPid);
    assert.equal((await control({ operation: "claim" })).task, null, "restarting must not repeat an already leased notification");
    const recovered = new Client({ name: "recovered-original-window", version: "test" });
    clients.push(recovered);
    await recovered.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/seat/${binding.key}`)));
    const mine = (await recovered.callTool({ name: "my_state", arguments: {} })).structuredContent as any;
    assert.equal(mine.playerId, "a");
    assert.equal(mine.task.actionId, dispatched.jobId);
    assert.equal(mine.task.expectedStateVersion, dispatched.stateVersion);
    const submitted = await recovered.callTool({ name: "submit_action", arguments: { actionId: mine.task.actionId, expectedStateVersion: mine.task.expectedStateVersion, action: { type: "start" } } });
    assert.equal(submitted.isError, undefined);
    const publicState = await (await fetch(`${base}/api/games/restart-match`)).json() as any;
    assert.equal(publicState.phase, "achievement_selection");
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
    // Only terminate processes created by this isolated test; never search or kill by name/port.
    supervisor.kill("SIGTERM");
    await delay(100);
    if (existsSync(ownerFile)) ownedPids.add(owner().pid);
    for (const pid of ownedPids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await delay(100);
    rmSync(directory, { recursive: true, force: true });
  }
});
