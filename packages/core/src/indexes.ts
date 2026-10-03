import type { Key } from "./facts.ts";
import { get, put } from "./emit.ts";
import { dictionary, type ThreadState } from "./state.ts";

export function refreshItemIndex(state: ThreadState, key: Key): void {
  const item = get(state.items, key);
  if (
    item?.type === "tool_call" &&
    ["running", "pending", "awaiting_approval"].includes(item.call.status)
  ) {
    put(state.indexes.liveTools, key, true);
  } else delete state.indexes.liveTools[key];
  if (get(state.itemLinks, key)) registerItemLink(state, key);
}

export function refreshInteractionIndex(state: ThreadState, key: Key): void {
  if (get(state.interactions, key)?.state === "pending")
    put(state.indexes.pendingInteractions, key, true);
  else delete state.indexes.pendingInteractions[key];
}

export function refreshTaskIndex(state: ThreadState, key: Key): void {
  if (
    get(state.tasks, key)?.status === "running" ||
    (get(state.tasks, key)?.status === "unknown" &&
      state.uncertainTasks &&
      get(state.uncertainTasks, key))
  )
    put(state.indexes.runningTasks, key, true);
  else delete state.indexes.runningTasks[key];
}

export function refreshAgentIndex(
  state: ThreadState,
  key: Key,
  previousParentId?: string | null,
): void {
  const record = get(state.agents, key);
  if (!record) return;
  put(state.indexes.agentKeysById, record.agent.id, key);
  if (
    previousParentId !== undefined &&
    previousParentId !== null &&
    previousParentId !== record.agent.parentId
  ) {
    const previous = get(state.indexes.childrenByParent, previousParentId);
    if (previous) delete previous[key];
  }
  if (record.agent.parentId === null) return;
  const children = get(state.indexes.childrenByParent, record.agent.parentId) ?? dictionary<true>();
  put(children, key, true);
  put(state.indexes.childrenByParent, record.agent.parentId, children);
}

export function registerSpawnLink(state: ThreadState, agentKey: Key, itemKey: Key): void {
  const agents = get(state.indexes.pendingSpawnLinks, itemKey) ?? dictionary<true>();
  put(agents, agentKey, true);
  put(state.indexes.pendingSpawnLinks, itemKey, agents);
}

export function registerItemLink(state: ThreadState, itemKey: Key): void {
  put(state.indexes.pendingItemLinks, itemKey, true);
}

export function liveToolKeys(state: ThreadState, agentId?: string): Key[] {
  return Object.keys(state.indexes.liveTools).filter(
    (key) => agentId === undefined || get(state.items, key)?.agentId === agentId,
  );
}

export function pendingInteractionKeys(state: ThreadState, agentId?: string): Key[] {
  return Object.keys(state.indexes.pendingInteractions).filter(
    (key) => agentId === undefined || get(state.interactions, key)?.agentId === agentId,
  );
}

export function runningTaskKeys(state: ThreadState, agentId?: string): Key[] {
  return Object.keys(state.indexes.runningTasks).filter(
    (key) => agentId === undefined || get(state.tasks, key)?.agentId === agentId,
  );
}
