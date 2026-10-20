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
