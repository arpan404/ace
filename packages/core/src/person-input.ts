import { get } from "./emit.ts";
import { pendingInteractionKeys } from "./indexes.ts";
import type { ThreadState } from "./state.ts";
import type { AgentStatus } from "@ace/protocol";

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

/**
 * Whether the provider's own work keeps a compaction out now. The provider compacts its own
 * idle history, so a live turn always holds it: running, starting, lost, retrying, waiting on
 * the person, or waiting on its foreground subagents (their parent's turn is still live, and
 * Claude's `/compact` would join it while Pi refuses it). Only work that runs without the model
 * a turn ended with — a background shell or monitor — leaves the provider free to compact.
 * This is `acceptsPersonInput`'s rule seen from the agent status clients and the fake hold.
 */
export function compactionBlocked(status: AgentStatus | undefined): boolean {
  if (status === undefined) return false;
  if (status.state === "blocked") return status.on !== "background_task";
  return (
    status.state === "working" || status.state === "starting" || status.state === "unresponsive"
  );
}

/**
 * What Continue sends after a Stop, a restart or a usage limit. It is the person's go-ahead, so
 * it is written as their own words and shows as their message.
 */
export const continueMessage = "Continue where you left off.";
