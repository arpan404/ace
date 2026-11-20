import type { ThreadState } from "@ace/core";

/*
 * What a Stop (`thread.interrupt`) reaches, decided once for every part of ace that acts on it:
 * the handler's queue hold, the delivery's shell stop and close fallback, and agent control's
 * cancellation cascade. Naming the root agent's own id is the same as naming no agent.
 */

/** The Stop is about the thread's root agent: no agent named, or the root's own id. */
export function targetsRoot(
  p: { agentId?: string | undefined },
  rootAgentId: string | undefined,
): boolean {
  return p.agentId === undefined || p.agentId === rootAgentId;
}

/** A Stop of the whole thread: it cascades and targets the root, so everything under it stops. */
export function stopsWholeThread(
  p: { cascade: boolean; agentId?: string | undefined },
  rootAgentId: string | undefined,
): boolean {
  return p.cascade && targetsRoot(p, rootAgentId);
}

/**
 * The provider's own background work a whole-thread Stop stops (shells, monitors), by task key:
 * running, and never ace's own rows. A live move waits on the same list to read empty.
 */
export function stoppableTasks(state: ThreadState): string[] {
  return Object.entries(state.tasks)
    .filter(([, task]) => task.status === "running" && task.owner !== "ace" && !task.internal)
    .map(([key]) => key);
}

/**
 * Those of `stoppableTasks` a whole-thread Stop asks the provider to stop: the ones it said it
 * can stop. Work it can't stop is left to end (ADR 0052) and keeps the thread waiting meanwhile,
 * as `thread.task.stop` refuses it (`task_not_stoppable`).
 */
export function tasksToStop(state: ThreadState): string[] {
  return stoppableTasks(state).filter((key) => state.tasks[key]?.stoppable === true);
}

/**
 * Those of `stoppableTasks` the provider said it can't stop (an ACP shell that outlived its
 * prompt, say): a whole-thread Stop leaves them a bounded time to end (`Sessions.closeAfter`).
 */
export function tasksLeftToEnd(state: ThreadState): string[] {
  return stoppableTasks(state).filter((key) => state.tasks[key]?.stoppable !== true);
}
