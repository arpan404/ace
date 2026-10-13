import { aceWaitTargets } from "@ace/mcp-server";
import type { Fact, ThreadState } from "@ace/core";

/**
 * A live ace wait tool call (ace_wait, or delegate_task with a wait)
 * marks its agent as waiting for the children it names, so the parent reads "Waiting on N
 * subagents" rather than plain working. Delegated children appear in the parent tree as
 * `ace-child:<threadId>` summary agents; ids that are not children never become refs.
 */
export function aceWaitFact(state: ThreadState, fact: Fact): Fact | undefined {
  if (fact.type !== "item.upsert" && fact.type !== "item.reconciled") return undefined;
  const item = state.items[fact.item];
  if (
    item?.type !== "tool_call" ||
    (item.call.status !== "running" && item.call.status !== "pending")
  )
    return undefined;
  if (state.itemLinks[fact.item]?.waitingFor !== undefined) return undefined;
  const detail = item.call.detail;
  if (detail.kind !== "mcp" || detail.server !== "ace") return undefined;
  const targets = aceWaitTargets(detail.tool, detail.arguments);
  if (!targets) return undefined;
  return {
    type: "subagents.waiting",
    agent: fact.agent,
    item: fact.item,
    targets: targets.map((id) => `ace-child:${id}`),
  };
}
