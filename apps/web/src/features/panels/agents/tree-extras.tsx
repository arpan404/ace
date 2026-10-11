import { useThread } from "@ace/client-react";
import type { ThreadReader } from "@ace/client";
import { isRunning } from "@ace/ui-core";

interface Counts {
  active: number;
  done: number;
  failed: number;
  unresponsive: number;
  stopped: number;
}
const sameCounts = (a: Counts, b: Counts) =>
  a.active === b.active &&
  a.done === b.done &&
  a.failed === b.failed &&
  a.unresponsive === b.unresponsive &&
  a.stopped === b.stopped;
const readIds = (reader: ThreadReader) => reader.agentIds();
const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, at) => id === b[at]);
/** Subagents only: the root agent is the conversation itself. */
const countSubagents = (reader: ThreadReader): Counts => {
  const counts = { active: 0, done: 0, failed: 0, unresponsive: 0, stopped: 0 };
  for (const id of reader.agentIds()) {
    const agent = reader.agent(id);
    if (!agent || agent.origin === "root") continue;
    if (isRunning(agent)) counts.active++;
    else if (agent.status.state === "idle") counts.done++;
    else if (agent.status.state === "failed") counts.failed++;
    else if (agent.status.state === "unresponsive") counts.unresponsive++;
    else if (agent.status.state === "interrupted") counts.stopped++;
  }
  return counts;
};

/** "2 active · 4 done" above the tree; a quiet line when none is active. */
export function AgentCounts(props: { threadId: string }) {
  const ids = useThread(props.threadId, ["agents"], readIds, sameIds) ?? [];
  const counts = useThread(
    props.threadId,
    ["agents", ...ids.map((id) => `agent:${id}` as const)],
    countSubagents,
    sameCounts,
  );
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
