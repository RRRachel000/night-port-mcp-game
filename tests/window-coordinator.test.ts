import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GameRuleError } from "../src/engine.js";
import { GameStore } from "../src/store.js";
import { WindowCoordinator } from "../src/window-coordinator.js";
import type { WindowAction } from "../src/window-types.js";
import type { NightPortGame } from "../src/engine.js";
import type { WindowControl } from "../src/window-types.js";

function fixture(human = false) {
  const directory = mkdtempSync(join(tmpdir(), "night-port-window-test-"));
  const store = new GameStore(directory);
  const { game } = store.create({ gameId: "windows", creatorId: "a", creatorName: "A", creatorType: "ai", creatorToken: "old-a", seed: "windows" });
  for (const id of ["b", "c"]) game.joinPlayer({ playerId: id, playerName: id.toUpperCase(), controllerType: human && id === "b" ? "human" : "ai", playerToken: `old-${id}`, expectedStateVersion: game.stateVersion });
  store.save(game);
  let time = 1000;
  const options = { now: () => time, leaseMs: 100, retryMs: 10, maxAttempts: 3 };
  const coordinator = new WindowCoordinator(store, options);
  const keys = Object.fromEntries(["a", "b", "c"].map(playerId => [playerId, coordinator.bind("windows", { playerId, threadId: `thread-${playerId}`, hostId: "local", kind: human && playerId === "b" ? "manual" : "codex" }).key]));
  return { directory, store, coordinator, keys, options, advance: (ms: number) => { time += ms; }, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function submitCurrent(coordinator: WindowCoordinator, key: string, action: WindowAction) {
  const state = coordinator.myState(key);
  const task = state.task as { actionId: string; expectedStateVersion: number };
  assert.ok(task);
  return coordinator.submit(key, task.actionId, task.expectedStateVersion, action);
}

function choose(coordinator: WindowCoordinator, key: string) {
  const state = coordinator.myState(key);
  const candidates = (state.privateState as { achievementCandidates: Array<{ id: string }> }).achievementCandidates;
  return submitCurrent(coordinator, key, { type: "choose_achievement", achievementId: candidates[0]!.id });
}

function assertCode(operation: () => unknown, code: string) {
  assert.throws(operation, (error: unknown) => error instanceof GameRuleError && error.code === code);
}

test("persistent window jobs cover AI start, selection, votes, turns and stop at finish", () => {
  const f = fixture();
  try {
    const phases = new Set<string>();
    for (let step = 0; step < 100; step++) {
      const task = f.coordinator.claim("windows") as { jobId: string; dispatchId: string; playerId: string } | null;
      if (!task) break;
      assert.equal(f.coordinator.claim("windows"), null, "overlapping dispatchers must not claim twice");
      f.coordinator.report("windows", task.jobId, task.dispatchId);
      const key = f.keys[task.playerId]!;
      const mine = f.coordinator.myState(key);
      const actionType = (mine.task as { actionType: string }).actionType;
      phases.add(actionType);
      if (actionType === "start") submitCurrent(f.coordinator, key, { type: "start" });
      else if (actionType === "choose_achievement") choose(f.coordinator, key);
      else if (actionType === "vote_carryover") submitCurrent(f.coordinator, key, { type: "vote_carryover", approve: true });
      else submitCurrent(f.coordinator, key, { type: "take_turn", marketPositions: [] });
    }
    assert.deepEqual([...phases].sort(), ["choose_achievement", "start", "take_turn", "vote_carryover"]);
    assert.equal(f.store.get("windows").publicState().phase, "finished");
    assert.equal(f.coordinator.claim("windows"), null);
    assert.equal(f.coordinator.publicStatus("windows").status, "finished");
  } finally { f.cleanup(); }
});

test("restart keeps leases, retries uncompleted notification, then blocks without passing", () => {
  const f = fixture();
  try {
    const original = f.coordinator.claim("windows") as { jobId: string; dispatchId: string };
    f.coordinator.report("windows", original.jobId, original.dispatchId);
    const restarted = new WindowCoordinator(new GameStore(f.directory), f.options);
    assert.equal(restarted.claim("windows"), null);
    const version = f.store.get("windows").stateVersion;
    for (let attempt = 2; attempt <= 3; attempt++) {
      f.advance(101);
      assert.equal(restarted.claim("windows"), null);
      f.advance(50);
      const retry = restarted.claim("windows") as { jobId: string; dispatchId: string; attempt: number };
      assert.equal(retry.jobId, original.jobId);
      assert.equal(retry.attempt, attempt);
      assert.notEqual(retry.dispatchId, original.dispatchId);
      assertCode(() => restarted.report("windows", original.jobId, original.dispatchId), "STALE_DISPATCH");
    }
    f.advance(101);
    assert.equal(restarted.claim("windows"), null);
    assert.equal(restarted.publicStatus("windows").status, "blocked");
    assert.equal(new GameStore(f.directory).get("windows").stateVersion, version);
    restarted.setPaused("windows", false);
    assert.ok(restarted.claim("windows"));
  } finally { f.cleanup(); }
});

test("lost successful response returns its persisted receipt even after restart", () => {
  const f = fixture();
  try {
    const state = f.coordinator.myState(f.keys.a!);
    const task = state.task as { actionId: string; expectedStateVersion: number };
    const result = f.coordinator.submit(f.keys.a!, task.actionId, task.expectedStateVersion, { type: "start" });
    const restartedStore = new GameStore(f.directory);
    const restarted = new WindowCoordinator(restartedStore, f.options);
    const retry = restarted.submit(f.keys.a!, task.actionId, task.expectedStateVersion, { type: "start" });
    assert.equal(retry.replayed, true);
    assert.equal(retry.stateVersion, result.stateVersion);
    assert.equal(restartedStore.get("windows").fullLog().filter((entry) => entry.type === "game_started").length, 1);
    assertCode(() => restarted.submit(f.keys.a!, task.actionId, task.expectedStateVersion, { type: "vote_carryover", approve: true }), "ACTION_ID_REUSED");
  } finally { f.cleanup(); }
});

test("human participation waits and is never automatically passed or notified as AI", () => {
  const f = fixture(true);
  try {
    submitCurrent(f.coordinator, f.keys.a!, { type: "start" });
    choose(f.coordinator, f.keys.a!);
    const before = f.store.get("windows").stateVersion;
    f.advance(1_000_000);
    assert.equal(f.coordinator.claim("windows"), null);
    assert.equal(f.coordinator.publicStatus("windows").status, "waiting_human");
    assert.equal(f.store.get("windows").stateVersion, before);
    choose(f.coordinator, f.keys.b!);
    assert.ok(f.coordinator.claim("windows"));
  } finally { f.cleanup(); }
});

test("takeover preserves the seat and revokes the old connection and legacy token", () => {
  const f = fixture();
  try {
    submitCurrent(f.coordinator, f.keys.a!, { type: "start" });
    choose(f.coordinator, f.keys.a!);
    const before = f.store.get("windows").exportSnapshot();
    const oldToken = before.players[0]!.token;
    const replacement = f.coordinator.bind("windows", { playerId: "a", threadId: "replacement", hostId: "local", kind: "codex" }, true);
    assertCode(() => f.coordinator.myState(f.keys.a!), "CONNECTION_REVOKED");
    const newStore = new GameStore(f.directory);
    const restarted = new WindowCoordinator(newStore, f.options);
    assert.equal(restarted.myState(replacement.key).playerId, "a");
    assertCode(() => newStore.get("windows").privateState({ playerId: "a", playerToken: oldToken }), "PLAYER_AUTH_FAILED");
    const afterPlayer = newStore.get("windows").exportSnapshot().players[0]!;
    assert.deepEqual({ ...afterPlayer, token: oldToken }, before.players[0]);
    assert.equal(afterPlayer.chosenAchievementId, before.players[0]!.chosenAchievementId);
  } finally { f.cleanup(); }
});

test("pause prevents writes and resuming does not execute an old dispatch", () => {
  const f = fixture();
  try {
    const dispatch = f.coordinator.claim("windows") as { jobId: string; dispatchId: string };
    const task = f.coordinator.myState(f.keys.a!).task as { actionId: string; expectedStateVersion: number };
    f.coordinator.setPaused("windows", true);
    assert.equal(f.coordinator.claim("windows"), null);
    assertCode(() => f.coordinator.submit(f.keys.a!, task.actionId, task.expectedStateVersion, { type: "start" }), "MATCH_PAUSED");
    f.coordinator.setPaused("windows", false);
    assertCode(() => f.coordinator.report("windows", dispatch.jobId, dispatch.dispatchId), "STALE_DISPATCH");
    assert.ok(f.coordinator.claim("windows"));
  } finally { f.cleanup(); }
});

test("public state, dispatch prompts and status never reveal seat keys, tokens or hidden choices", () => {
  const f = fixture();
  try {
    const task = f.coordinator.claim("windows");
    const publicJson = JSON.stringify({ task, state: f.store.get("windows").publicState(), runtime: f.coordinator.publicStatus("windows") });
    for (const key of Object.values(f.keys)) assert.equal(publicJson.includes(key), false);
    for (const player of f.store.get("windows").exportSnapshot().players) assert.equal(publicJson.includes(player.token), false);
    assert.equal(publicJson.includes("keyHash"), false);
    assert.equal(publicJson.includes("achievementCandidates"), false);
    const aTask = f.coordinator.myState(f.keys.a!).task as { actionId: string; expectedStateVersion: number };
    assertCode(() => f.coordinator.submit(f.keys.b!, aTask.actionId, aTask.expectedStateVersion, { type: "start" }), "UNKNOWN_ACTION");
  } finally { f.cleanup(); }
});

test("a failed disk commit changes neither the in-memory game nor its jobs or receipts", () => {
  const f = fixture();
  try {
    class FailingStore extends GameStore {
      fail = false;
      protected override persist(game: NightPortGame, control?: WindowControl): void {
        if (this.fail) throw new Error("Injected disk failure");
        super.persist(game, control);
      }
    }
    // Use the real store transaction, injecting failure only at its disk boundary.
    const store = new FailingStore(f.directory);
    const coordinator = new WindowCoordinator(store, f.options);
    const state = coordinator.myState(f.keys.a!);
    const task = state.task as { actionId: string; expectedStateVersion: number };
    const before = readFileSync(join(f.directory, "windows.json"), "utf8");
    const snapshot = store.get("windows").exportSnapshot();
    const jobs = store.windowControl("windows");
    store.fail = true;
    assert.throws(() => coordinator.submit(f.keys.a!, task.actionId, task.expectedStateVersion, { type: "start" }), /Injected disk failure/);
    assert.deepEqual(store.get("windows").exportSnapshot(), snapshot);
    assert.deepEqual(store.windowControl("windows"), jobs);
    assert.equal(readFileSync(join(f.directory, "windows.json"), "utf8"), before);
  } finally { f.cleanup(); }
});

test("duplicate purchase changes cash, inventory and turn count only once", () => {
  const f = fixture();
  try {
    submitCurrent(f.coordinator, f.keys.a!, { type: "start" });
    for (const id of ["a", "b", "c"]) choose(f.coordinator, f.keys[id]!);
    const publicState = f.store.get("windows").publicState();
    const id = publicState.currentPlayer as string;
    const slot = (publicState.market as Array<{ position: number; occupied: boolean; inspectionCargo: boolean; currentPrice: number }>).find(item => item.occupied && !item.inspectionCargo)!;
    const before = f.store.get("windows").exportSnapshot().players.find(player => player.id === id)!;
    const task = f.coordinator.myState(f.keys[id]!).task as { actionId: string; expectedStateVersion: number };
    const action: WindowAction = { type: "take_turn", marketPositions: [slot.position] };
    const first = f.coordinator.submit(f.keys[id]!, task.actionId, task.expectedStateVersion, action);
    const restartedStore = new GameStore(f.directory);
    const restarted = new WindowCoordinator(restartedStore, f.options);
    assert.equal(restarted.submit(f.keys[id]!, task.actionId, task.expectedStateVersion, action).replayed, true);
    const after = restartedStore.get("windows").exportSnapshot().players.find(player => player.id === id)!;
    assert.equal(after.cash, before.cash - slot.currentPrice);
    assert.equal(after.inventory.length, before.inventory.length + 1);
    assert.equal(restartedStore.get("windows").stateVersion, first.stateVersion);
    assertCode(() => restarted.submit(f.keys[id]!, task.actionId, task.expectedStateVersion, { type: "take_turn", marketPositions: [] }), "ACTION_ID_REUSED");
  } finally { f.cleanup(); }
});

test("taking over the currently dispatched seat invalidates stale jobs and late callbacks", () => {
  const f = fixture();
  try {
    const old = f.coordinator.claim("windows") as { jobId: string; dispatchId: string };
    const oldTask = f.coordinator.myState(f.keys.a!).task as { actionId: string; expectedStateVersion: number };
    const replacement = f.coordinator.bind("windows", { playerId: "a", threadId: "new-a", hostId: "local", kind: "codex" }, true);
    assertCode(() => f.coordinator.submit(f.keys.a!, oldTask.actionId, oldTask.expectedStateVersion, { type: "start" }), "CONNECTION_REVOKED");
    assertCode(() => f.coordinator.submit(replacement.key, oldTask.actionId, oldTask.expectedStateVersion, { type: "start" }), "UNKNOWN_ACTION");
    assert.equal(f.coordinator.report("windows", old.jobId, old.dispatchId).status, "superseded");
    const next = f.coordinator.claim("windows") as { threadId: string; jobId: string };
    assert.equal(next.threadId, "new-a");
    assert.notEqual(next.jobId, old.jobId);
  } finally { f.cleanup(); }
});
