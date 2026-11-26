import type { Fact } from "@ace/core";
import { compactionBlocked } from "@ace/core";
import type { ContextMeter, EventPayload, ThreadView } from "@ace/protocol";

/**
 * Providers whose own compaction ace can request, as the real adapters declare: Claude, Codex,
 * OpenCode and Pi. Cursor and ACP have no native request, so the fake offers none either.
 */
export const fakeCompactionProviders = new Set(["claude", "codex", "opencode", "pi"]);

/**
 * What a fake provider does with `thread.compact`: the provider's own compaction as a short turn
 * and one compaction row, or the error a real daemon would answer.
 */
export function fakeCompaction(
  view: ThreadView,
  rootKey: string,
  now: number,
): { facts: Fact[] } | { error: string } {
  if (!view.thread.capabilities?.compaction) return { error: "unsupported_compact" };
  const rootId = view.thread.rootAgentId ?? rootKey;
  if (compactionBlocked(view.agents[rootId]?.status)) return { error: "thread_not_idle" };
  const before = view.contextMeters?.[rootId]?.usedTokens ?? undefined;
  return {
    facts: [
      { type: "turn.started", agent: rootKey, trigger: "user" },
      { type: "activity", agent: rootKey, activity: "compacting" },
      {
        type: "item.upsert",
        agent: rootKey,
        item: `fake:compact:${now}`,
        draft: {
          type: "compaction",
          complete: true,
          summary: "The earlier turns, summarised by the provider.",
          ...(before === undefined ? {} : { tokensBefore: before }),
          ...(before === undefined ? {} : { tokensAfter: Math.round(before / 3) }),
        },
      },
      { type: "turn.ended", agent: rootKey, outcome: "completed" },
    ],
  };
}

type MeterUpdate = Extract<EventPayload, { type: "context_meter.updated" }>;

/** The daemon's replaceable context meter after a sample, or after a finished compaction. */
export function fakeMeterUpdates(
  payload: EventPayload,
  meters: Record<string, ContextMeter> | undefined,
): MeterUpdate[] {
  if (payload.type === "context.sampled")
    return [
      {
        type: "context_meter.updated",
        meter: {
          agentId: payload.agentId,
          epoch: (meters?.[payload.agentId]?.epoch ?? 0) + 1,
          usedTokens: payload.usedTokens,
          windowTokens: payload.windowTokens ?? null,
          ...(payload.model ? { model: payload.model } : {}),
          source: "provider",
        },
      },
    ];
  // A finished compaction leaves the earlier occupancy unknown until the provider samples
  // again, exactly as the daemon's own meter does.
  if (
    (payload.type === "item.created" || payload.type === "item.updated") &&
    payload.item.type === "compaction" &&
    payload.item.complete
  ) {
    const prior = meters?.[payload.item.agentId];
    return [
      {
        type: "context_meter.updated",
        meter: {
          agentId: payload.item.agentId,
          epoch: (prior?.epoch ?? 0) + 1,
          usedTokens: null,
          windowTokens: prior?.windowTokens ?? null,
          ...(prior?.model ? { model: prior.model } : {}),
          source: "provider",
        },
      },
    ];
  }
  return [];
}
