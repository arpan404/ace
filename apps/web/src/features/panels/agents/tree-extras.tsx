import type { Agent } from "@ace/protocol";
import { subagentBranchStates, subagentStatusLine } from "@ace/ui-core";
import type { TreeWork } from "./tree-work-context.ts";

/**
 * "1 working · 1 failed" above the tree: the main agent's subagents by branch, in the same
 * line the transcript's subagents block prints and the live line's count agrees with.
 */
export function AgentCounts(props: { agents: readonly Agent[]; work: TreeWork }) {
  const line = subagentStatusLine(subagentBranchStates(props.agents, props.work));
  if (!line) return null;
  return (
    <p role="status" className="px-2 pt-1 pb-1.5 text-xs text-subtle-foreground tabular-nums">
      {line}
    </p>
  );
}
