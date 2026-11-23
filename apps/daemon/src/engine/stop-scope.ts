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
 * Those of `stoppableTasks` the provider said it can't stop that only its session's end can end:
 * work that takes the thread's next prompt away while it runs (an ACP shell that outlived its
 * reply), and an ACP shell the agent keeps open across turns (`endsWithSession`). A whole-thread
 * Stop gives them a bounded time to end, then closes the session (`Sessions.closeAfter`). Other
 * work it can't stop is left to end; Claude's placeholder for an unbound subagent ends by itself.
 */
export function tasksEndingWithSession(state: ThreadState): string[] {
  return stoppableTasks(state).filter((key) => {
    const task = state.tasks[key];
    return (
      task?.stoppable !== true && (task?.blocksPrompts === true || task?.endsWithSession === true)
    );
  });
}
