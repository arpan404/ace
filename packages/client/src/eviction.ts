import type { ThreadView } from "@ace/protocol";
import type { ThreadKey } from "./readers.ts";

/*
 * What a long-lived thread may forget (ADR 0056 bounded memory). Each collection is capped at
 * the entity limit; past it, the oldest entries that no longer matter to what is shown or to
 * status are dropped and their keys emitted, so the thread keeps working for as long as it runs.
 */

/** Item ids in the window, and the background tasks their tool calls point at. */
function loadedReferences(view: ThreadView): { items: Set<string>; tasks: Set<string> } {
  const items = new Set<string>();
  const tasks = new Set<string>();
  for (const id of view.itemOrder) {
    const item = Object.hasOwn(view.items, id) ? view.items[id] : undefined;
    if (!item) continue;
    items.add(id);
    if (item.type === "tool_call" && item.call.backgroundTaskId)
      tasks.add(item.call.backgroundTaskId);
  }
  return { items, tasks };
}

/**
 * Drop up to `count` of the oldest closed interactions no loaded item belongs to. A pending one
 * always stays: it is what the thread is waiting on.
 */
export function closedInteractions(view: ThreadView, count: number, keys?: Set<ThreadKey>): number {
  const { items } = loadedReferences(view);
  let freed = 0;
  for (const [id, interaction] of Object.entries(view.interactions)) {
    if (freed >= count) break;
    if (interaction.state === "pending") continue;
    if (interaction.toolCallId && items.has(interaction.toolCallId)) continue;
    delete view.interactions[id];
    keys?.add(`interaction:${id}`);
    freed++;
  }
  if (freed) keys?.add("interactions");
  return freed;
}

/**
 * Drop up to `count` of the oldest background tasks that have ended and that no loaded item
 * started or points at. A running (or lost, `unknown`) task always stays: it can hold the
 * thread open.
 */
export function endedTasks(view: ThreadView, count: number, keys?: Set<ThreadKey>): number {
  const { items, tasks } = loadedReferences(view);
  let freed = 0;
  for (const [id, task] of Object.entries(view.backgroundTasks)) {
    if (freed >= count) break;
    if (task.status === "running" || task.status === "unknown") continue;
    if (tasks.has(id) || (task.toolCallId && items.has(task.toolCallId))) continue;
    delete view.backgroundTasks[id];
    keys?.add(`task:${id}`);
    freed++;
  }
  if (freed) keys?.add("tasks");
  return freed;
}

/**
 * Drop up to `count` of the oldest ended runs that no loaded item belongs to, so a thread with
 * more turns than the entity limit keeps working for as long as it runs. Active runs and the
 * runs of loaded items stay: status and turn grouping never depend on an evicted run.
 */
export function endedRuns(view: ThreadView, count: number, keys?: Set<ThreadKey>): number {
  const referenced = new Set<string>();
  for (const id of view.itemOrder) {
    const runId = Object.hasOwn(view.items, id) ? view.items[id]?.runId : undefined;
    if (runId) referenced.add(runId);
  }
  let freed = 0;
  for (const [id, run] of Object.entries(view.runs)) {
    if (freed >= count) break;
    if (run.state === "active" || referenced.has(id)) continue;
    delete view.runs[id];
    keys?.add(`run:${id}`);
    freed++;
  }
  return freed;
}

/** Keep retained references and their ancestors; settled historical branches can page back. */
export function endedAgents(view: ThreadView, count: number, keys?: Set<ThreadKey>): number {
  const keep = new Set<string>(view.thread.rootAgentId ? [view.thread.rootAgentId] : []);
  for (const entity of [
    ...Object.values(view.items),
    ...Object.values(view.runs),
    ...Object.values(view.interactions),
    ...Object.values(view.backgroundTasks),
  ])
    if (entity.agentId) keep.add(entity.agentId);
  for (const agent of Object.values(view.agents))
    if (!["idle", "interrupted", "failed"].includes(agent.status.state)) keep.add(agent.id);
  for (const id of keep) {
    const parent = Object.hasOwn(view.agents, id) ? view.agents[id]?.parentId : undefined;
    if (parent) keep.add(parent);
  }
  let freed = 0;
  for (const id of Object.keys(view.agents)) {
    if (freed >= count) break;
    if (keep.has(id)) continue;
    const parent = view.agents[id]?.parentId;
    if (parent && Object.hasOwn(view.agentChildren, parent))
      view.agentChildren[parent] = (view.agentChildren[parent] ?? []).filter(
        (child) => child !== id,
      );
    delete view.agentChildren[id];
    delete view.agents[id];
    delete view.usage[id];
    if (view.contextMeters) delete view.contextMeters[id];
    keys?.add(`agent:${id}`);
    keys?.add(`usage:${id}`);
    keys?.add(`context:${id}`);
    freed++;
  }
  if (freed) keys?.add("agents");
  return freed;
}
