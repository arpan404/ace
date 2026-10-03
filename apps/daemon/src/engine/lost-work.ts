import type { ProviderBackend } from "@ace/engine-api";
import type { ThreadState } from "@ace/core";
export function lostWork(
  state: ThreadState,
  pendingNativeInputs = 0,
  backend?: ProviderBackend,
): string | undefined {
  const lines: string[] = [];
  for (const key of Object.keys(state.indexes.runningTasks)) {
    const task = state.tasks[key];
    if (!task || task.status !== "running") continue;
    if (lines.length < 64)
      lines.push(`${task.kind}: ${task.title.slice(0, 160)} [${task.id.slice(0, 128)}]`);
  }
  let active = state.queueSources.provider > 0 || pendingNativeInputs > 0;
  for (const record of Object.values(state.agents)) {
    if (record.externalStatus) continue;
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
  const instruction =
    backend === "cursor-sdk"
      ? "ace restarted. The previous Cursor SDK host is unavailable. Native run, child and tool outcomes remain uncertain until checkpoint reconciliation. Continue only after recovery confirms safe native continuation; never replay possibly delivered input."
      : "ace restarted. The previous provider process stopped. Continue the interrupted task from native history. Recheck unfinished tools and expired approvals before relying on their results.";
  const heading =
    backend === "cursor-sdk"
      ? "The following background work is unresolved:"
      : "The following background work died or became unreachable:";
  return `${instruction}\n${lines.length ? `${heading}\n${lines.join("\n")}\nRecheck it before restarting. This list is limited to 64 entries.` : "No known background work was live."}`.slice(
    0,
    16384,
  );
}
