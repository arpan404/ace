import type { Agent } from "@ace/protocol";
import type { TreeWork } from "./tree-work-context.ts";

interface Counts {
  active: number;
  done: number;
  failed: number;
  unresponsive: number;
  stopped: number;
}
/** Subagents remain active until their descendants and background work settle. */
function countSubagents(agents: readonly Agent[], work: TreeWork): Counts {
  const counts = { active: 0, done: 0, failed: 0, unresponsive: 0, stopped: 0 };
  for (const agent of agents) {
    if (agent.origin === "root") continue;
    if (work.running.has(agent.id)) counts.active++;
    else if (agent.status.state === "idle") counts.done++;
    else if (agent.status.state === "failed") counts.failed++;
    else if (agent.status.state === "unresponsive") counts.unresponsive++;
    else if (agent.status.state === "interrupted") counts.stopped++;
  }
  return counts;
}

/** "2 active · 4 done" above the tree; a quiet line when none is active. */
export function AgentCounts(props: { agents: readonly Agent[]; work: TreeWork }) {
  const counts = countSubagents(props.agents, props.work);
  if (
    !counts ||
    counts.active + counts.done + counts.failed + counts.unresponsive + counts.stopped === 0
  )
    return null;
  return (
    <p role="status" className="px-2 pt-1 pb-1.5 text-xs text-subtle-foreground tabular-nums">
      {counts.active ? `${counts.active} active` : "No active subagents"} · {counts.done} done
      {counts.failed ? ` · ${counts.failed} failed` : ""}
      {counts.unresponsive ? ` · ${counts.unresponsive} unresponsive` : ""}
      {counts.stopped ? ` · ${counts.stopped} stopped` : ""}
    </p>
  );
}
