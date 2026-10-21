import type { BackgroundTask, Item } from "@ace/protocol";

/*
 * How a background task presents, shared by the daemon's live hints and every client surface.
 * A task can be the agent's own work (a shell, a monitor), stand for a subagent, or be ace's
 * bookkeeping. All of them hold the thread open while they run; only some are shown, and only a
 * shell is named by its command. Pure.
 */

type Task = Pick<BackgroundTask, "kind" | "internal" | "childAgentId">;

/** ace's own bookkeeping: it holds the thread open, but no surface lists or names it. */
export function isInternalTask(task: Pick<BackgroundTask, "internal">): boolean {
  return task.internal === true;
}

/**
 * Work of a subagent that has no agent of its own yet (the provider hasn't registered it):
 * every surface counts it as that subagent, never as a background command. A task with its
 * child agent leaves the counting to the agent.
 */
export function standsForSubagent(task: Task): boolean {
  return task.kind === "subagent" && task.childAgentId === undefined && !isInternalTask(task);
}

/** A task shown as background work of its own: neither bookkeeping nor a stand-in subagent. */
export function listedBackgroundWork(task: Task): boolean {
  return !isInternalTask(task) && !standsForSubagent(task);
}

/**
 * The command a background shell runs, for naming it as code: its tool call's command, else
 * the task's title. Undefined for anything that isn't a shell, or a shell whose command ace
 * doesn't know.
 */
export function shellCommandOf(
  task: Pick<BackgroundTask, "kind" | "title" | "internal">,
  item: Item | undefined,
): string | undefined {
  if (task.kind !== "shell" || isInternalTask(task)) return undefined;
  const command =
    item?.type === "tool_call" && item.call.detail.kind === "shell"
      ? item.call.detail.command
      : task.title;
  return command.trim() || undefined;
}
