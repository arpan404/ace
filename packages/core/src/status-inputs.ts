import type { Item } from "@ace/protocol";
import { lookup, type ThreadState } from "./state.ts";
import { liveToolKeys, pendingInteractionKeys, runningTaskKeys } from "./indexes.ts";
import { subtreeSignalReader, transportSignalAt } from "./liveness.ts";

type ToolItem = Extract<Item, { type: "tool_call" }>;

function byAgent<T extends { agentId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentId) ?? [];
    group.push(value);
    grouped.set(value.agentId, group);
  }
  return grouped;
}

export function isLiveTool(item: Item): item is ToolItem {
  return (
    item.type === "tool_call" &&
    (item.call.status === "running" ||
      item.call.status === "pending" ||
      item.call.status === "awaiting_approval")
  );
}

/** One immutable-fact view per synchronous status or deadline pass. */
export function statusInputs(state: ThreadState) {
  const interactionsByAgent = byAgent(
    pendingInteractionKeys(state).flatMap((key) => {
      const interaction = lookup(state.interactions, key);
      return interaction ? [interaction] : [];
    }),
  );
  const tasksByAgent = byAgent(
    runningTaskKeys(state).flatMap((key) => {
      const task = lookup(state.tasks, key);
      return task && !task.ambient ? [task] : [];
    }),
  );
  const toolsByAgent = byAgent(
    liveToolKeys(state).flatMap((key) => {
      const item = lookup(state.items, key);
      return item && isLiveTool(item) ? [item] : [];
    }),
  );
  return {
    lastTransportSignalAt: transportSignalAt(state),
    byId: state.indexes.agentKeysById,
    interactionsByAgent,
    tasksByAgent,
    toolsByAgent,
    children: state.indexes.childrenByParent,
    lastSubtreeSignal: subtreeSignalReader(state),
    waitingOwners: new Set([
      ...interactionsByAgent.keys(),
      ...tasksByAgent.keys(),
      ...toolsByAgent.keys(),
    ]),
  };
}

/** Any live owned work or completion-relevant child suppresses active-run silence. */
export function suppressesActiveSilence(
  waitingOwners: Set<string>,
  agentId: string,
  liveChildren: number,
): boolean {
  return waitingOwners.has(agentId) || liveChildren > 0;
}
