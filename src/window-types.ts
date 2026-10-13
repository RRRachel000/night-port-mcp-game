export type WindowAction =
  | { type: "start" }
  | { type: "choose_achievement"; achievementId: string }
  | { type: "take_turn"; marketPositions: number[]; orderId?: string; emergencyOrderId?: string }
  | { type: "vote_carryover"; approve: boolean };

export interface WindowRoute {
  playerId: string;
  threadId: string;
  hostId: string;
  kind: "codex" | "chatgpt" | "manual";
  generation: number;
  keyHash: string;
}

export type DispatchFailure = "window_unavailable" | "transport_unavailable" | "credential_unavailable" | "dispatch_uncertain" | "action_timeout";

export interface WindowJob {
  id: string;
  playerId: string;
  generation: number;
  stateVersion: number;
  actionType: WindowAction["type"];
  status: "pending" | "leased" | "awaiting_action" | "retry_wait" | "blocked" | "completed" | "superseded";
  attempts: number;
  availableAt: number;
  leaseId?: string;
  leaseUntil?: number;
  failure?: DispatchFailure;
  receipt?: { fingerprint: string; result: Record<string, unknown> };
}

export interface WindowControl {
  schemaVersion: 1;
  paused: boolean;
  routes: WindowRoute[];
  jobs: WindowJob[];
}

export function emptyWindowControl(): WindowControl {
  return { schemaVersion: 1, paused: false, routes: [], jobs: [] };
}
