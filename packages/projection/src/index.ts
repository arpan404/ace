export {
  isRawHistoryItem,
  historyMessageIdentity,
  visibleHistoryOrder,
} from "./history-visibility.ts";
export { threadAttention } from "./thread-attention.ts";
export { withoutPortableHandoff } from "./portable-input.ts";
import { usageSnapshotKey } from "./usage.ts";
export {
  emptyTurnDigest,
  itemMessagePreview,
  itemDigestContribution,
  agentThreadStatus,
  turnIsSettled,
  turnActivityStatus,
  approvalAutoReviewed,
} from "./long-thread.ts";
export type { DigestContribution } from "./long-thread.ts";
export { usageSnapshotKey } from "./usage.ts";
import { applyDelta } from "./delta.ts";
export {
  acceptsDelta,
  applyDelta,
  outputDeltas,
  outputStreamId,
  summarizeOutput,
  utf8Slice,
  utf8Tail,
} from "./delta.ts";
export { applyItemsPage, trackItem } from "./window.ts";
import type {
  DeliveryEvent,
  Event,
  EventBatch,
  Progress,
  Thread,
  ThreadListView,
  ThreadListEntry,
  ThreadView,
} from "@ace/protocol";
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
    itemsBefore: null,
    interactions: {},
    backgroundTasks: {},
    usage: {},
    contextMeters: {},
    usageSnapshots: {},
  };
}
export function createThreadListView(threads: Thread[] = [], seq = 0): ThreadListView {
  return {
    kind: "threads",
    seq,
    threads: Object.fromEntries(
      threads
        .filter((thread) => thread.deletedAt === undefined)
        .map((thread) => [thread.id, sidebarEntry(thread)]),
    ),
  };
}
function sidebarEntry(thread: Thread): ThreadListEntry {
  const { rootAgentId: _root, ...entry } = structuredCopy(thread);
  return entry;
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
export function reparentAgent(
  view: ThreadView,
  id: string,
  oldParent: string | null | undefined,
  nextParent: string | null,
): void {
  if (oldParent === nextParent) return;
  if (oldParent && oldParent !== nextParent) {
    const children = (get(view.agentChildren, oldParent) ?? []).filter((child) => child !== id);
    if (children.length) put(view.agentChildren, oldParent, children);
    else delete view.agentChildren[oldParent];
  }
  if (nextParent) {
    const children = get(view.agentChildren, nextParent) ?? [];
    children.push(id);
    put(view.agentChildren, nextParent, children);
  }
}
/** Rebuild the derived parent index after loading materialized agents. */
export function rebuildAgentChildren(view: ThreadView): void {
  view.agentChildren = {};
  const parents = new Map<string, Set<string>>();
  for (const agent of Object.values(view.agents)) {
    if (!agent.parentId) continue;
    let children = parents.get(agent.parentId);
    if (!children) {
      children = new Set();
      parents.set(agent.parentId, children);
    }
    children.add(agent.id);
  }
  for (const [parent, children] of parents) put(view.agentChildren, parent, [...children]);
}
function advance(view: { seq: number }, event: DeliveryEvent): ApplyResult {
  if (event.seq <= view.seq) return { kind: "ignored" };
  const first = event.firstSeq ?? event.seq;
  if (first !== view.seq + 1) return { kind: "gap", expected: view.seq + 1, received: first };
  view.seq = event.seq;
  return { kind: "applied" };
}
export function updateThread(thread: Thread, event: Event): void {
  if (event.payload.type === "queue.updated") {
    const { type: _type, ...queue } = event.payload;
    thread.queue = queue;
  }
  const payload = event.payload;
  if (payload.type === "thread.client.updated") {
    for (const [key, value] of Object.entries(payload.changes)) {
      if (value === null) Reflect.deleteProperty(thread, key);
      else
        Object.defineProperty(thread, key, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
    }
  }
  if (payload.type === "thread.updated") {
    if (payload.workspaceId !== undefined) thread.workspaceId = payload.workspaceId;
    if (payload.permission !== undefined) thread.permission = structuredCopy(payload.permission);
    if (payload.backend !== undefined) {
      thread.backend = payload.backend;
      if (payload.backend === "cursor-sdk") delete thread.continuation;
    }
    if (payload.capabilities !== undefined)
      thread.capabilities = structuredCopy(payload.capabilities);
    if (payload.provider !== undefined) thread.provider = payload.provider;
    if (payload.lineage !== undefined) thread.lineage = structuredCopy(payload.lineage);
    if (payload.execution !== undefined) thread.execution = structuredCopy(payload.execution);
    if (payload.switch !== undefined) thread.switch = structuredCopy(payload.switch);
    if (payload.title !== undefined) thread.title = payload.title;
    if (payload.titleSource !== undefined) thread.titleSource = payload.titleSource;
    if (payload.effectiveCapabilities !== undefined)
      thread.effectiveCapabilities = structuredCopy(payload.effectiveCapabilities);
    if (payload.acpSupport !== undefined) thread.acpSupport = structuredCopy(payload.acpSupport);
    if (payload.status !== undefined) {
      thread.status = structuredCopy(payload.status);
      thread.activitySeq = event.seq;
    }
    if (payload.archivedAt === null) delete thread.archivedAt;
    else if (payload.archivedAt !== undefined) thread.archivedAt = payload.archivedAt;
  }
  if (payload.type === "agent.created" && payload.agent.origin === "root")
    thread.rootAgentId = payload.agent.id;
  if (isSidebarEvent(event)) thread.updatedAt = event.at;
}
export function isSidebarEvent(event: Event): boolean {
  if (event.payload.type === "queue.updated") return true;
  return (
    event.payload.type === "thread.created" ||
    event.payload.type === "thread.updated" ||
    event.payload.type === "thread.client.updated"
  );
}
export function applyThreadListEvent(view: ThreadListView, event: DeliveryEvent): ApplyResult {
  const result = advance(view, event);
  if (result.kind !== "applied") return result;
  foldThreadList(view, event);
  return result;
}
function foldThreadList(view: ThreadListView, event: DeliveryEvent): void {
  if (event.payload.type === "thread.created")
    put(view.threads, event.threadId, sidebarEntry(event.payload.thread));
  const thread = get(view.threads, event.threadId);
  if (thread && isSidebarEvent(event)) updateThread(thread, event);
  if (thread?.deletedAt !== undefined) delete view.threads[event.threadId];
}

export function applyEvent(view: ThreadView, event: DeliveryEvent): ApplyResult {
  if (event.threadId !== view.thread.id)
    return { kind: "gap", expected: view.seq + 1, received: event.firstSeq ?? event.seq };
  const result = advance(view, event);
  if (result.kind !== "applied") return result;
  foldEvent(view, event);
  return result;
}
function foldEvent(view: ThreadView, event: DeliveryEvent): void {
  if (event.threadId !== view.thread.id) throw new Error("Event outside thread scope");
  const p = event.payload;
  updateThread(view.thread, event);
  switch (p.type) {
    case "thread.created":
      view.thread = structuredCopy(p.thread);
      view.thread.updatedAt = event.at;
      break;
    case "thread.updated":
    case "thread.client.updated":
    case "workspace.files_changed":
      break;
    case "agent.created": {
      const previous = get(view.agents, p.agent.id);
      reparentAgent(view, p.agent.id, previous?.parentId, p.agent.parentId);
      put(view.agents, p.agent.id, structuredCopy(p.agent));
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
        if (p.parentId !== undefined) reparentAgent(view, p.agentId, agent.parentId, p.parentId);
        Object.assign(agent, structuredCopy(changes));
      }
      break;
    }
    case "run.client.updated": {
      const run = get(view.runs, p.runId);
      if (run) run.checkpoints = structuredCopy(p.checkpoints);
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
        if (p.error) run.error = structuredCopy(p.error);
        if (p.trigger !== undefined) run.trigger = p.trigger;
      }
      break;
    }
    case "item.created":
    case "item.updated": {
      if (
        p.type === "item.updated" &&
        view.itemsBefore !== null &&
        !Object.hasOwn(view.items, p.item.id)
      )
        break;
      if (!Object.hasOwn(view.items, p.item.id)) view.itemOrder.push(p.item.id);
      put(view.items, p.item.id, structuredCopy(p.item));
      break;
    }
    case "item.deleted":
      delete view.items[p.itemId];
      view.itemOrder = view.itemOrder.filter((id) => id !== p.itemId);
      break;
    case "item.delta": {
      const item = get(view.items, p.itemId);
      if (item) applyDelta(item, p.field, p.append);
      break;
    }
    case "interaction.opened":
      put(view.interactions, p.interaction.id, structuredCopy(p.interaction));
      break;
    case "permission.reviewed": {
      const interaction = get(view.interactions, p.review.interactionId);
      if (interaction) interaction.review = structuredCopy(p.review);
      break;
    }
    case "interaction.closed": {
      const interaction = get(view.interactions, p.interactionId);
      if (interaction) {
        interaction.state = p.state;
        interaction.closedAt = p.closedAt;
        if (p.expirationReason !== undefined) interaction.expirationReason = p.expirationReason;
        if (p.resolution !== undefined) interaction.resolution = structuredCopy(p.resolution);
        if (p.resolvedBy !== undefined) interaction.resolvedBy = p.resolvedBy;
        if (p.autoReviewed !== undefined) interaction.autoReviewed = p.autoReviewed;
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
    case "context.sampled":
      break;
    case "queue.updated": {
      const { type: _type, ...queue } = p;
      view.queue = queue;
      break;
    }
    case "context_meter.updated":
      view.contextMeters ??= {};
      put(view.contextMeters, p.meter.agentId, structuredCopy(p.meter));
      break;
    case "input.admitted":
      if (p.commandId) {
        const item = get(view.items, `input:${p.commandId}`);
        if (item?.type === "message" && item.agentId === p.agentId) item.nativeId = p.nativeInputId;
      }

      break;
    case "usage.updated":
      if (p.usageScope === "provider_session" || p.usageScope === "model_session")
        put(view.usageSnapshots, usageSnapshotKey(p), structuredCopy(p));
      else put(view.usage, p.agentId, structuredCopy(p));
      break;
    default: {
      const exhaustive: never = p;
      return exhaustive;
    }
  }
}

/** Apply a scoped interval atomically. Host gaps inside it represent filtered events.
 * The declared predecessor detects a missing batch or progress frame. */
export function applyDelivery(
  view: ThreadView | ThreadListView,
  message: EventBatch | Progress,
): ApplyResult {
  if (message.throughSeq <= view.seq) return { kind: "ignored" };
  if (message.afterSeq !== view.seq)
    return { kind: "gap", expected: view.seq, received: message.afterSeq };
  const events = message.type === "events" ? message.events : [];
  let last = message.afterSeq;
  for (const event of events) {
    const first = event.firstSeq ?? event.seq;
    if (first <= last || first > event.seq || event.seq > message.throughSeq)
      return { kind: "gap", expected: last + 1, received: first };
    if (
      (view.kind === "thread" && event.threadId !== view.thread.id) ||
      (view.kind === "threads" && !isSidebarEvent(event))
    )
      return { kind: "gap", expected: last + 1, received: first };
    last = event.seq;
  }
  for (const event of events) {
    if (view.kind === "thread") foldEvent(view, event);
    else foldThreadList(view, event);
  }
  view.seq = message.throughSeq;
  return { kind: "applied" };
}

export {
  organizationCommands,
  organizationDecision,
  settleDecision,
  settlePolicy,
} from "./organization.ts";
export type { SettlePolicy } from "./organization.ts";

export { liveMetadata, boundedLiveModel } from "./live-metadata.ts";
export { isTestCommand } from "./step-purpose.ts";
export { digestFromCounters, digestContributions, mergeTurnDigests } from "./long-thread-merge.ts";

export { threadMoveError, movedThreadDetails, threadMoveEvents } from "./thread-move.ts";

export { sidebarSettled, sidebarVisible, sidebarPage } from "./sidebar-page.ts";

export { distinctRetainedInputs } from "./retained-inputs.ts";
