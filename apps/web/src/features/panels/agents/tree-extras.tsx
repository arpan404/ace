import { useThread } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { isRunning } from "@ace/ui-core";

interface Counts {
  active: number;
  done: number;
}
const sameCounts = (a: Counts, b: Counts) => a.active === b.active && a.done === b.done;
/** Subagents only: the root agent is the conversation itself. */
const countSubagents = (reader: ThreadReader): Counts => {
  const counts = { active: 0, done: 0 };
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent || agent.origin === "root") continue;
    if (isRunning(agent)) counts.active++;
    else counts.done++;
  }
  return counts;
};

/** "2 active · 4 done" above the tree; a quiet line when none is active. */
export function AgentCounts(props: { threadId: string }) {
  const counts = useThread(props.threadId, ["agents"], countSubagents, sameCounts);
  if (!counts || counts.active + counts.done === 0) return null;
  return (
    <p role="status" className="px-2 pt-1 pb-1.5 text-xs text-subtle-foreground tabular-nums">
      {counts.active ? `${counts.active} active` : "No active subagents"} · {counts.done} done
    </p>
  );
}
