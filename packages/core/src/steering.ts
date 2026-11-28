import type { Item } from "@ace/protocol";
import type { ThreadState } from "./state.ts";

/** Foreground shell calls run to completion before a steer is delivered. */
export function isRunningShellTool(
  item: Item | undefined,
): item is Extract<Item, { type: "tool_call" }> {
  return (
    item?.type === "tool_call" &&
    item.call.status === "running" &&
    item.call.detail.kind === "shell"
  );
}

/** A promoted background command never holds the next steer. */
export function hasForegroundShellCommand(
  tools: Iterable<Item | undefined>,
  backgroundToolCalls: Iterable<string | undefined>,
): boolean {
  const background = new Set(backgroundToolCalls);
  for (const item of tools) if (isRunningShellTool(item) && !background.has(item.id)) return true;
  return false;
}

/** The thread's live foreground shells, whichever agent of it runs them. */
function liveForegroundCommand(state: ThreadState): boolean {
  return hasForegroundShellCommand(
    Object.keys(state.indexes.liveTools).map((key) => state.items[key]),
    Object.keys(state.indexes.runningTasks).map((key) => state.tasks[key]?.toolCallId),
  );
}

/** Read only live work, never transcript history; background tasks do not hold steering. */
export function hasRunningForegroundCommand(state: ThreadState): boolean {
  const root = state.rootKey === undefined ? undefined : state.agents[state.rootKey]?.agent.id;
  if (root === undefined) return false;
  return hasForegroundShellCommand(
    Object.keys(state.indexes.liveTools)
      .map((key) => state.items[key])
      .filter((item) => item?.agentId === root),
    Object.keys(state.indexes.runningTasks).map((key) => state.tasks[key]?.toolCallId),
  );
}

/**
 * A foreground shell anywhere in this thread's tree, not just the root's: cancelling the root
 * stops the commands its native children run too. Every agent in one state belongs to this
 * thread; a delegated thread keeps a state of its own.
 */
export function hasRunningForegroundCommandInTree(state: ThreadState): boolean {
  if (state.rootKey === undefined) return false;
  return liveForegroundCommand(state);
}
