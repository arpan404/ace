import type { Item } from "@ace/protocol";
import { lookup, type ThreadState } from "./state.ts";
import { liveToolKeys, pendingInteractionKeys, runningTaskKeys } from "./indexes.ts";
import { subtreeSignalReader, transportSignalAt } from "./liveness.ts";
import { holdsThread } from "./background-hold.ts";
import type { BackgroundTask } from "@ace/protocol";

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

/**
 * Whether `task`'s agent finished its last turn on its own: no turn runs, and the last one
 * completed rather than being stopped or failing (ADR 0109).
 */
export function ownerTurnFinished(
  state: ThreadState,
  task: Pick<BackgroundTask, "agentId">,
): boolean {
  return agentTurnFinished(state, task.agentId);
}

function agentTurnFinished(state: ThreadState, agentId: string): boolean {
  const key = lookup(state.indexes.agentKeysById, agentId);
  const record = key === undefined ? undefined : lookup(state.agents, key);
  if (!record || record.activeRun || !record.lastRun) return false;
  return lookup(state.runs, record.lastRun)?.state === "completed";
}

/**
 * `holdsThread` (ADR 0109, ADR 0116) for a live task in `state`. Work is past its agent's final
 * reply only once both its own agent and the thread's main agent finished their turns: a
 * subagent's command still holds while the main agent works and may be waiting on it.
 */
export function taskHoldsThread(state: ThreadState, task: BackgroundTask): boolean {
  const root = state.rootKey === undefined ? undefined : lookup(state.agents, state.rootKey);
  const replied =
    ownerTurnFinished(state, task) && (!root || agentTurnFinished(state, root.agent.id));
  return holdsThread(task, replied);
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
      return task && taskHoldsThread(state, task) ? [task] : [];
    }),
  );
  const toolsByAgent = byAgent(
    liveToolKeys(state).flatMap((key) => {
      const item = lookup(state.items, key);
      return item && isLiveTool(item) ? [item] : [];
    }),
  );
  const waitsByAgent = byAgent(
    liveToolKeys(state).flatMap((key) => {
      const targets = lookup(state.itemLinks, key)?.waitingFor;
      const item = lookup(state.items, key);
      return targets !== undefined && item && item.type === "tool_call"
        ? [{ agentId: item.agentId, targets }]
        : [];
    }),
  );
  return {
    waitsByAgent,
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
