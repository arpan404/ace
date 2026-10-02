import type { DeliveryEvent, Event, Thread, ThreadListView, ThreadView } from "@ace/protocol";
export type { ThreadView, ThreadListView } from "@ace/protocol";

export type ApplyResult =
  | { kind: "applied" | "ignored" }
  | { kind: "gap"; expected: number; received: number };
export function createThreadView(thread: Thread, seq = 0): ThreadView {
  return {
    kind: "thread",
    seq,
    thread: structuredCopy(thread),
    agents: {},
    agentChildren: {},
    runs: {},
    items: {},
    itemOrder: [],
    interactions: {},
    backgroundTasks: {},
    usage: {},
  };
}
export function createThreadListView(threads: Thread[] = [], seq = 0): ThreadListView {
  return {
    kind: "threads",
    seq,
    threads: Object.fromEntries(threads.map((thread) => [thread.id, structuredCopy(thread)])),
  };
}
// JSON copy keeps the package usable on runtimes without structuredClone.
function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function get<T>(record: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(record, id) ? record[id] : undefined;
}
function put<T>(record: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(record, id, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
function advance(view: { seq: number }, event: DeliveryEvent): ApplyResult {
  if (event.seq <= view.seq) return { kind: "ignored" };
  const first = event.firstSeq ?? event.seq;
  if (first !== view.seq + 1) return { kind: "gap", expected: view.seq + 1, received: first };
  view.seq = event.seq;
  return { kind: "applied" };
}
export function updateThread(thread: Thread, event: Event): void {
  const payload = event.payload;
  if (payload.type === "thread.updated") {
    if (payload.title !== undefined) thread.title = payload.title;
    if (payload.status !== undefined) thread.status = structuredCopy(payload.status);
    if (payload.archivedAt === null) delete thread.archivedAt;
    else if (payload.archivedAt !== undefined) thread.archivedAt = payload.archivedAt;
  }
  thread.updatedAt = event.at;
}
export function applyThreadListEvent(view: ThreadListView, event: DeliveryEvent): ApplyResult {
  const result = advance(view, event);
  if (result.kind !== "applied") return result;
  if (event.payload.type === "thread.created")
    put(view.threads, event.threadId, structuredCopy(event.payload.thread));
  const thread = get(view.threads, event.threadId);
  if (thread) updateThread(thread, event);
  return result;
}
export function applyEvent(view: ThreadView, event: DeliveryEvent): ApplyResult {
  const result = advance(view, event);
  if (result.kind !== "applied" || event.threadId !== view.thread.id) return result;
  const p = event.payload;
  updateThread(view.thread, event);
  switch (p.type) {
    case "thread.created":
      view.thread = structuredCopy(p.thread);
      view.thread.updatedAt = event.at;
      break;
    case "thread.updated":
      break;
    case "agent.created": {
      const previous = get(view.agents, p.agent.id);
      if (previous?.parentId)
        put(
          view.agentChildren,
          previous.parentId,
          (get(view.agentChildren, previous.parentId) ?? []).filter((id) => id !== p.agent.id),
        );
      put(view.agents, p.agent.id, structuredCopy(p.agent));
      if (p.agent.parentId) {
        const children = get(view.agentChildren, p.agent.parentId) ?? [];
        put(view.agentChildren, p.agent.parentId, children);
        if (!children.includes(p.agent.id)) children.push(p.agent.id);
      }
      break;
    }
    case "agent.status": {
      const agent = get(view.agents, p.agentId);
      if (agent) agent.status = structuredCopy(p.status);
      break;
    }
    case "agent.updated": {
      const agent = get(view.agents, p.agentId);
      if (agent) {
        const { type: _type, agentId: _id, ...changes } = p;
        Object.assign(agent, changes);
      }
      break;
    }
    case "run.started":
      put(view.runs, p.run.id, structuredCopy(p.run));
      break;
    case "run.ended": {
      const run = get(view.runs, p.runId);
      if (run) {
        run.state = p.state;
        run.endedAt = p.endedAt;
        if (p.trigger !== undefined) run.trigger = p.trigger;
      }
      break;
    }
    case "item.created":
    case "item.updated": {
      if (!Object.hasOwn(view.items, p.item.id)) view.itemOrder.push(p.item.id);
      put(view.items, p.item.id, structuredCopy(p.item));
      break;
    }
    case "item.delta": {
      const item = get(view.items, p.itemId);
      if (item?.type === "message" && p.field === "text") {
        const part = item.parts.at(-1);
        if (part?.type === "text") part.text += p.append;
        else item.parts.push({ type: "text", text: p.append });
      } else if (item?.type === "reasoning" && p.field === "reasoning") item.text += p.append;
      else if (
        item?.type === "tool_call" &&
        item.call.detail.kind === "shell" &&
        p.field === "output"
      )
        item.call.detail.output = (item.call.detail.output ?? "") + p.append;
      break;
    }
    case "interaction.opened":
      put(view.interactions, p.interaction.id, structuredCopy(p.interaction));
      break;
    case "interaction.closed": {
      const interaction = get(view.interactions, p.interactionId);
      if (interaction) {
        interaction.state = p.state;
        interaction.closedAt = p.closedAt;
        if (p.resolution !== undefined) interaction.resolution = structuredCopy(p.resolution);
        if (p.resolvedBy !== undefined) interaction.resolvedBy = p.resolvedBy;
      }
      break;
    }
    case "background_task.started":
      put(view.backgroundTasks, p.task.id, structuredCopy(p.task));
      break;
    case "background_task.updated": {
      const task = get(view.backgroundTasks, p.taskId);
      if (task) {
        task.status = p.status;
        if (p.endedAt !== undefined) task.endedAt = p.endedAt;
      }
      break;
    }
    case "usage.updated":
      put(view.usage, p.agentId, structuredCopy(p));
      break;
    default: {
      const exhaustive: never = p;
      return exhaustive;
    }
  }
  return result;
}
