import type { AgentRecord, ThreadState } from "@ace/core";

/** An agent between turns whose only hold is its own background commands. */
function idleBetweenTurns(record: AgentRecord, now: number): boolean {
  if (record.activeRun || record.retry || record.limited || record.disconnectedAt !== undefined)
    return false;
  if (record.wakeUntil !== undefined && record.wakeUntil > now) return false;
  const status = record.agent.status;
  return status.state === "blocked" && status.on === "background_task";
}

/**
 * Whether a person's queued message can start the next turn. Stricter readiness (`quiescent`)
 * gates forks and switches; a message only needs the provider between turns. Background
 * commands (a dev server, a watcher) keep running and keep the thread from reading done, but
 * they never hold the person's next message. Subagents, live tools, requests waiting on a
 * person and uncertain work still hold it. Cost is proportional to live work, never history.
 */
export function acceptsPersonInput(
  state: ThreadState,
  blockers: Iterable<string>,
  now: number,
): boolean {
  if (state.queueSources.provider) return false;
  if (Object.keys(state.indexes.liveTools).length) return false;
  if (Object.keys(state.indexes.pendingInteractions).length) return false;
  if (Object.keys(state.uncertainTasks ?? {}).length) return false;
  for (const key of Object.keys(state.indexes.runningTasks)) {
    const task = state.tasks[key];
    if (!task || task.kind === "subagent" || task.childAgentId !== undefined) return false;
  }
  for (const key of blockers) {
    const record = state.agents[key];
    if (record && !idleBetweenTurns(record, now)) return false;
  }
  return true;
}
