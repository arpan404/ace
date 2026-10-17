import { get } from "./emit.ts";
import { pendingInteractionKeys } from "./indexes.ts";
import type { ThreadState } from "./state.ts";

/**
 * Whether the provider can take a person's message as its next turn now. The person talks to
 * the root agent, so only the root's own turn matters: a running turn, a retry or limit, a lost
 * connection, a wake the provider announced, or a request the root is waiting on. Work that
 * keeps going on its own (background commands, monitors, subagents, a child's tools or
 * questions) never holds the message; it keeps running and keeps the thread from reading done.
 * A provider-side queue is still drained first, so the message keeps its order behind it.
 * Cost is proportional to live requests, never to history.
 */
export function acceptsPersonInput(state: ThreadState, now: number): boolean {
  if (state.queueSources.provider) return false;
  const root = state.rootKey === undefined ? undefined : get(state.agents, state.rootKey);
  if (!root) return true;
  if (root.activeRun || root.retry || root.limited || root.disconnectedAt !== undefined)
    return false;
  if (root.wakeUntil !== undefined && root.wakeUntil > now) return false;
  return pendingInteractionKeys(state, root.agent.id).length === 0;
}
