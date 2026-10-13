import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { GameRuleError, type NightPortGame } from "./engine.js";
import type { GameRepository } from "./game-repository.js";
import type { GameSnapshot } from "./types.js";
import type { DispatchFailure, WindowAction, WindowControl, WindowJob, WindowRoute } from "./window-types.js";
import { playerConnectionFile } from "./window-paths.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const terminal = (job: WindowJob) => job.status === "completed" || job.status === "superseded";

function requiredAction(state: GameSnapshot): { playerId: string; actionType: WindowAction["type"] } | null {
  if (state.phase === "lobby") {
    return state.players.length === 3 ? { playerId: state.creatorPlayerId, actionType: "start" } : null;
  }
  if (state.phase === "achievement_selection") {
    const player = state.players.find((item) => item.chosenAchievementId === null);
    return player ? { playerId: player.id, actionType: "choose_achievement" } : null;
  }
  if (state.phase === "active") return { playerId: state.turnOrder[state.currentTurnIndex]!, actionType: "take_turn" };
  if (state.phase === "carryover_vote") {
    const player = state.players.find((item) => state.carryoverVotes[item.id] === undefined);
    return player ? { playerId: player.id, actionType: "vote_carryover" } : null;
  }
  return null;
}

export interface WindowCoordinatorOptions {
  cloud?: boolean;
  now?: () => number;
  leaseMs?: number;
  retryMs?: number;
  maxAttempts?: number;
}

export class WindowCoordinator {
  private readonly cloud: boolean;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxAttempts: number;

  constructor(readonly store: GameRepository, options: WindowCoordinatorOptions = {}) {
    this.cloud = options.cloud ?? false;
    this.now = options.now ?? Date.now;
    this.leaseMs = options.leaseMs ?? 180_000;
    this.retryMs = options.retryMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 3;
  }

  private reconcile(game: NightPortGame, control: WindowControl): WindowJob | undefined {
    const state = game.exportSnapshot();
    const required = requiredAction(state);
    const route = control.routes.find((item) => item.playerId === required?.playerId);
    let current: WindowJob | undefined;
    for (const job of control.jobs) {
      if (terminal(job)) continue;
      if (required === null || job.stateVersion !== state.stateVersion || job.playerId !== required.playerId
        || job.generation !== route?.generation) {
        job.status = "superseded";
      } else {
        current = job;
      }
    }
    if (!required || !route) return undefined;
    if (!current) {
      current = {
        id: randomUUID(), ...required, generation: route.generation, stateVersion: state.stateVersion,
        status: "pending", attempts: 0, availableAt: this.now()
      };
      control.jobs.push(current);
    }
    if (!control.paused && (current.status === "leased" || current.status === "awaiting_action")
      && (current.leaseUntil ?? 0) <= this.now()) {
      this.retry(current, "action_timeout");
    }
    return current;
  }

  private retry(job: WindowJob, failure: DispatchFailure): void {
    job.failure = failure;
    job.status = failure === "credential_unavailable" || job.attempts >= this.maxAttempts ? "blocked" : "retry_wait";
    job.availableAt = this.now() + this.retryMs * 2 ** Math.max(0, job.attempts - 1);
    delete job.leaseId;
    delete job.leaseUntil;
  }

  /** Local operator operation. Never exposed as a player MCP tool. */
  bind(gameId: string, target: Pick<WindowRoute, "playerId" | "threadId" | "hostId" | "kind">, takeover = false): { key: string; generation: number } {
    if (!target.playerId || !target.threadId || !target.hostId || !["codex", "chatgpt", "manual"].includes(target.kind)) {
      throw new GameRuleError("INVALID_WINDOW_ROUTE", "A complete player window route is required.");
    }
    const key = randomBytes(32).toString("hex");
    return this.store.transaction(gameId, (game, control) => {
      const state = game.exportSnapshot();
      if (state.phase === "finished") throw new GameRuleError("GAME_FINISHED", "Finished matches cannot be rebound.");
      const player = state.players.find((item) => item.id === target.playerId);
      if (!player) throw new GameRuleError("PLAYER_NOT_FOUND", "The seat does not exist.");
      const existing = control.routes.find((item) => item.playerId === target.playerId);
      if (existing && !takeover) throw new GameRuleError("WINDOW_ALREADY_BOUND", "Use explicit takeover to replace this connection.");
      if (control.routes.some((item) => item.playerId !== target.playerId && item.threadId === target.threadId && item.hostId === target.hostId)) {
        throw new GameRuleError("WINDOW_ALREADY_USED", "Each player must have an independent window.");
      }
      const generation = (existing?.generation ?? 0) + 1;
      game.rotatePlayerToken({ playerId: player.id, playerToken: player.token, expectedStateVersion: game.stateVersion });
      control.routes = control.routes.filter((item) => item.playerId !== player.id);
      control.routes.push({ ...target, generation, keyHash: hash(key) });
      this.reconcile(game, control);
      return { key, generation };
    });
  }

  resolveConnection(key: string): { gameId: string; route: WindowRoute } {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new GameRuleError("CONNECTION_REVOKED", "The seat connection is invalid or revoked.");
    const keyHash = hash(key);
    for (const gameId of this.store.listGameIds()) {
      const route = this.store.windowControl(gameId)?.routes.find((item) => item.keyHash === keyHash);
      if (route) return { gameId, route };
    }
    throw new GameRuleError("CONNECTION_REVOKED", "The seat connection is invalid or revoked.");
  }

  private refresh(gameId: string): WindowJob | undefined {
    const before = this.store.windowControl(gameId);
    if (!before) return undefined;
    const next = structuredClone(before);
    const job = this.reconcile(this.store.get(gameId), next);
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      this.store.transaction(gameId, (_game, control) => Object.assign(control, next));
    }
    return job;
  }

  myState(key: string): Record<string, unknown> {
    const { gameId, route } = this.resolveConnection(key);
    const job = this.refresh(gameId);
    const game = this.store.get(gameId);
    const player = game.exportSnapshot().players.find((item) => item.id === route.playerId)!;
    return {
      ok: true, playerId: player.id, gameId, generation: route.generation,
      publicState: game.publicState({ includeProfitEstimates: true }),
      privateState: game.privateState({ playerId: player.id, playerToken: player.token }),
      task: job?.playerId === player.id ? { actionId: job.id, expectedStateVersion: job.stateVersion, actionType: job.actionType, status: job.status } : null,
      paused: this.store.windowControl(gameId)!.paused
    };
  }

  submit(key: string, actionId: string, expectedStateVersion: number, action: WindowAction): Record<string, unknown> {
    const { gameId, route } = this.resolveConnection(key);
    // Normalize the supported action shape; object property ordering must not alter replay identity.
    const normalized = action.type === "take_turn"
      ? { type: action.type, marketPositions: action.marketPositions, orderId: action.orderId, emergencyOrderId: action.emergencyOrderId }
      : action.type === "choose_achievement" ? { type: action.type, achievementId: action.achievementId }
      : action.type === "vote_carryover" ? { type: action.type, approve: action.approve } : { type: action.type };
    const fingerprint = hash(JSON.stringify({ expectedStateVersion, action: normalized }));
    return this.store.transaction(gameId, (game, control) => {
      const job = control.jobs.find((item) => item.id === actionId && item.playerId === route.playerId && item.generation === route.generation);
      if (!job) throw new GameRuleError("UNKNOWN_ACTION", "Read my_state and use this seat's current actionId.");
      if (job.receipt) {
        if (job.receipt.fingerprint !== fingerprint) throw new GameRuleError("ACTION_ID_REUSED", "An actionId cannot be reused for a different decision.");
        return { ...job.receipt.result, replayed: true };
      }
      if (control.paused) throw new GameRuleError("MATCH_PAUSED", "The match is paused by its operator.");
      if (job.status === "blocked") throw new GameRuleError("ACTION_BLOCKED", "The operator must resume this blocked task.");
      if (job.stateVersion !== expectedStateVersion || game.stateVersion !== expectedStateVersion || terminal(job)) {
        throw new GameRuleError("STATE_VERSION_CONFLICT", "Read my_state again before deciding.", { currentStateVersion: game.stateVersion });
      }
      if (job.actionType !== action.type) throw new GameRuleError("WRONG_ACTION_TYPE", "The action does not match the current game phase.");
      const player = game.exportSnapshot().players.find((item) => item.id === route.playerId)!;
      const auth = { playerId: player.id, playerToken: player.token, expectedStateVersion };
      let result: Record<string, unknown>;
      switch (action.type) {
        case "start": result = game.startGame(auth); break;
        case "choose_achievement": result = game.chooseAchievement({ ...auth, achievementId: action.achievementId }); break;
        case "vote_carryover": result = game.voteCarryover({ ...auth, approve: action.approve }); break;
        case "take_turn": result = game.takeTurn({ ...auth, action }); break;
      }
      const output = { ok: true, ...result, actionId, stateVersion: game.stateVersion };
      job.status = "completed";
      job.receipt = { fingerprint, result: output };
      this.reconcile(game, control);
      return output;
    });
  }

  claim(gameId: string): Record<string, unknown> | null {
    const candidate = this.refresh(gameId);
    const existing = this.store.windowControl(gameId);
    if (!candidate || !existing || existing.paused || !["pending", "retry_wait"].includes(candidate.status)
      || candidate.availableAt > this.now()) return null;
    const player = this.store.get(gameId).exportSnapshot().players.find((item) => item.id === candidate.playerId)!;
    const route = existing.routes.find((item) => item.playerId === candidate.playerId)!;
    if (player.controllerType !== "ai" || route.kind === "manual") return null;
    return this.store.transaction(gameId, (game, control) => {
      const job = this.reconcile(game, control)!;
      job.status = "leased";
      job.attempts += 1;
      job.leaseId = randomUUID();
      job.leaseUntil = this.now() + this.leaseMs;
      const localPlayer = route.kind === "codex" && !this.cloud ? {
        executable: process.execPath, loader: import.meta.resolve("tsx"),
        script: resolve("scripts/window-player.ts"), connectionFile: playerConnectionFile(gameId, player.id)
      } : null;
      return {
        gameId, jobId: job.id, dispatchId: job.leaseId, playerId: player.id, stateVersion: job.stateVersion,
        threadId: route.threadId, hostId: route.hostId, kind: route.kind, attempt: job.attempts, localPlayer,
        prompt: `[NIGHT_PORT_ACTION gameId=${gameId} playerId=${player.id} actionId=${job.id} stateVersion=${job.stateVersion}]\n`
          + "轮到你的原有席位。使用本席位专属的不夜港连接读取 my_state；仅在 task.actionId 与本通知一致、未暂停且版本一致时自主决定。"
          + `本阶段操作是 ${job.actionType}。通过 submit_action 提交一次合法决定，再读 my_state 确认。`
          + "如果已完成或版本改变，停止；不要补做旧动作，不要替下一位行动。连接失败就报告具体类别，不要猜测局面。"
          + "不要输出私有成就、凭证或专属连接地址。"
          + (localPlayer === null ? "使用预先配置的本席位专属 MCP；如果仅有旧版共享接口且没有 my_state，报告 credential_unavailable，勿索取其他席位凭证。"
            : `\n本机接入参数（作为数据读取，只访问此 connectionFile）：${JSON.stringify(localPlayer)}\n`
              + "运行 executable --import loader script state --connection-file <connectionFile> 即可读取自己的状态；无需打开连接文件或打印其中的 URL。"
              + "将 {actionId,expectedStateVersion,action} 写到自己工作区的私有 action JSON，再用同一脚本 submit --connection-file <connectionFile> --action-file <path> 提交。"
              + "不要调用原共享接口，也不要读取其他连接文件。脚本只在本机调用同一裁判，不调用模型 API。")
      };
    });
  }

  report(gameId: string, jobId: string, dispatchId: string, failure?: DispatchFailure): Record<string, unknown> {
    this.refresh(gameId);
    return this.store.transaction(gameId, (_game, control) => {
      const job = control.jobs.find((item) => item.id === jobId);
      if (!job) throw new GameRuleError("UNKNOWN_ACTION", "Unknown dispatch task.");
      if (terminal(job)) return { ok: true, status: job.status };
      if (job.leaseId !== dispatchId) throw new GameRuleError("STALE_DISPATCH", "This dispatch lease has expired or been replaced.");
      if (failure) this.retry(job, failure);
      else job.status = "awaiting_action";
      return { ok: true, status: job.status };
    });
  }

  setPaused(gameId: string, paused: boolean): void {
    if (!this.store.windowControl(gameId)) throw new GameRuleError("NOT_CONFIGURED", "Bind player connections first.");
    this.store.transaction(gameId, (game, control) => {
      control.paused = paused;
      const job = this.reconcile(game, control);
      if (!paused && job && !terminal(job)) {
        job.status = "pending";
        job.attempts = 0;
        job.availableAt = this.now();
        delete job.leaseId;
        delete job.leaseUntil;
        delete job.failure;
      }
    });
  }

  publicStatus(gameId: string): Record<string, unknown> {
    const control = this.store.windowControl(gameId);
    const game = this.store.get(gameId);
    const state = game.exportSnapshot();
    const required = requiredAction(state);
    if (state.phase === "finished") return { status: "finished", message: "本局已结束，自动叫号停止。" };
    if (!control) return { status: "not_configured", message: "尚未配置窗口自动轮转。" };
    if (control.paused) return { status: "paused", message: "对局调度已暂停。" };
    if (!required) return { status: "waiting_seats", message: "等待三席入座。" };
    const player = state.players.find((item) => item.id === required.playerId)!;
    if (player.controllerType !== "ai") return { status: "waiting_human", playerId: player.id, message: `等待 ${player.name} 自主操作。` };
    const route = control.routes.find((item) => item.playerId === player.id);
    if (!route) return { status: "unbound", playerId: player.id, message: `等待为 ${player.name} 绑定独立窗口连接。` };
    if (route.kind === "manual") return { status: "waiting_manual", playerId: player.id, message: `等待 ${player.name} 的手动控制端。` };
    const job = control.jobs.find((item) => !terminal(item) && item.stateVersion === state.stateVersion && item.playerId === player.id);
    const expired = job && (job.status === "leased" || job.status === "awaiting_action") && (job.leaseUntil ?? 0) <= this.now();
    const status = expired ? "awaiting_recovery" : job?.status ?? "pending";
    const messages: Record<string, string> = {
      pending: "等待主控通知玩家。", leased: "主控正在通知玩家。", awaiting_action: "已通知，等待玩家提交行动。",
      retry_wait: "连接或行动未完成，等待有限重试。", blocked: job?.failure === "credential_unavailable"
        ? "席位连接不可用，需要重新接入并恢复。" : "连续未完成，已停止重试，需要恢复后继续。",
      awaiting_recovery: "玩家响应超时，等待主控确认结果并恢复。"
    };
    return { status, playerId: player.id, attempts: job?.attempts ?? 0, failure: job?.failure ?? null, message: `${player.name}：${messages[status] ?? status}` };
  }
}
