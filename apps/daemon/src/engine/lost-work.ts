import type { ThreadState } from "@ace/core";
export function lostWork(state: ThreadState): string | undefined {
  const lines: string[] = [];
  for (const key of Object.keys(state.indexes.runningTasks)) {
    const task = state.tasks[key];
    if (!task || task.status !== "running") continue;
    if (lines.length < 64)
      lines.push(`${task.kind}: ${task.title.slice(0, 160)} [${task.id.slice(0, 128)}]`);
  }
  let active = false;
  for (const record of Object.values(state.agents)) {
    active ||= record.activeRun !== undefined || record.wakeUntil !== undefined;
    if (
      record.agent.origin === "root" ||
      ["idle", "interrupted", "failed"].includes(record.agent.status.state)
    )
      continue;
    if (lines.length < 64)
      lines.push(`subagent: ${(record.agent.name ?? record.agent.id).slice(0, 160)}`);
  }
  if (!active && !lines.length && !Object.keys(state.indexes.pendingInteractions).length)
    return undefined;
  return `ace restarted. The previous provider process stopped. Continue the interrupted task from native history. Recheck unfinished tools and expired approvals before relying on their results.\n${lines.length ? `The following background work died or became unreachable:\n${lines.join("\n")}\nRestart it if still needed. This list is limited to 64 entries.` : "No known background work was live."}`.slice(
    0,
    16384,
  );
}
