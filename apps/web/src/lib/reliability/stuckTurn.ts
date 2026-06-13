import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@ace/contracts";
import type { ChatMessage } from "~/types";

export interface StuckTurnSnapshot {
  isLikelyStuck: boolean;
  runningForMs: number;
  reason: "long-running-no-events" | "long-running" | null;
}

const NO_EVENT_STUCK_MS = 90_000;
const LONG_RUNNING_STUCK_MS = 10 * 60_000;
const RECENT_ACTIVITY_SUPPRESSION_MS = 30_000;

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function maxDefined(values: ReadonlyArray<number | null>): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    max = max === null ? value : Math.max(max, value);
  }
  return max;
}

function deriveLatestTurnActivityAt(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): number | null {
  const turnId = input.latestTurn?.turnId ?? null;
  return maxDefined([
    ...input.messages.flatMap((message) => {
      if (turnId !== null && message.turnId && message.turnId !== turnId) {
        return [];
      }
      return [
        parseTime(message.createdAt),
        parseTime(message.completedAt),
        message.streaming ? Date.now() : null,
      ];
    }),
    ...input.activities.flatMap((activity) => {
      if (turnId !== null && activity.turnId && activity.turnId !== turnId) {
        return [];
      }
      return [parseTime(activity.createdAt)];
    }),
  ]);
}

export function deriveStuckTurnSnapshot(input: {
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly now?: number;
}): StuckTurnSnapshot {
  const now = input.now ?? Date.now();
  const startedAt = parseTime(input.latestTurn?.startedAt ?? input.latestTurn?.requestedAt);
  if (input.latestTurn?.state !== "running" || startedAt === null) {
    return { isLikelyStuck: false, runningForMs: 0, reason: null };
  }

  const runningForMs = Math.max(0, now - startedAt);
  if (runningForMs < NO_EVENT_STUCK_MS) {
    return { isLikelyStuck: false, runningForMs, reason: null };
  }
  const latestActivityAt = deriveLatestTurnActivityAt(input);
  if (latestActivityAt !== null && now - latestActivityAt <= RECENT_ACTIVITY_SUPPRESSION_MS) {
    return { isLikelyStuck: false, runningForMs, reason: null };
  }

  if (runningForMs >= LONG_RUNNING_STUCK_MS) {
    return { isLikelyStuck: true, runningForMs, reason: "long-running" };
  }
  if (latestActivityAt === null || now - latestActivityAt >= NO_EVENT_STUCK_MS) {
    return { isLikelyStuck: true, runningForMs, reason: "long-running-no-events" };
  }
  return { isLikelyStuck: false, runningForMs, reason: null };
}
