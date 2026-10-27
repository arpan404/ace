import type { ThreadState } from "@ace/core";
import type { IntentHeader, EngineRepository } from "./repository.ts";
import { lostWorkLines } from "./lost-work.ts";

/** A user-selected replacement may retire blocked native work instead of waiting for it. */
export function usageBlocked(state: ThreadState): boolean {
  return Object.values(state.agents).some(
    (record) => record.limited !== undefined || record.externalStatus?.state === "limited",
  );
}

export function switchReady(repo: EngineRepository, intent: IntentHeader): boolean {
  const state = repo.requireState(intent.threadId);
  if (repo.quiescent(state)) return true;
  if (intent.kind !== "thread.switch" || !usageBlocked(state)) return false;
  const requested = repo.store.getThread(intent.threadId)?.switch?.selection;
  const current = repo.transitions.get(intent.threadId).selection;
  if (
    !requested ||
    !current ||
    (requested.provider === current.provider &&
      requested.model === current.model &&
      requested.instanceId === current.instanceId)
  )
    return false;
  const root = state.rootKey === undefined ? undefined : state.agents[state.rootKey];
  // An unrelated limited child must not cut off healthy foreground work in the root.
  return (
    !!root?.limited ||
    !root?.activeRun ||
    (root.agent.status.state === "blocked" &&
      ["subagents", "background_task"].includes(root.agent.status.on))
  );
}

/** Persisted before closing the source, delivered once with the replacement's first input. */
export function switchWorkContext(state: ThreadState, now: number): string | undefined {
  const native = lostWorkLines(state, 0, now) ?? [];
  const children = Object.values(state.agents).flatMap((record) => {
    const child = record.agent.childThreadId;
    if (
      !child ||
      !record.externalStatus ||
      ["done", "failed"].includes(record.externalStatus.state)
    )
      return [];
    return [`${child}: ${record.agent.native.provider}, ${JSON.stringify(record.externalStatus)}`];
  });
  if (!native.length && !children.length) return undefined;
  return [
    "Execution recovery after switching providers:",
    "A provider switch was requested. Source native work may have been interrupted and must be checked before restarting; no completion is implied.",
    ...native,
    "Independent delegated threads retain their task identities and workspace. Working children continue. Eligible limited children are scheduled to switch to the selected replacement. Paused, stopped or uncertain children remain held; inspect their status before creating replacements.",
    ...children.slice(0, 64),
    children.length > 64 ? `${children.length - 64} more children: inspect the agent tree.` : "",
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 16384);
}
