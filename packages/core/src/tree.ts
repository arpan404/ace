import { AgentId, type Agent, type EventPayload } from "@ace/protocol";
import type { AgentLinkedFact, AgentSeenFact, Key } from "./facts.ts";
import type { AgentRecord, ApplyContext, ThreadState } from "./state.ts";
import { emit, get, put } from "./emit.ts";
import { refreshAgentIndex, registerSpawnLink, registerItemLink } from "./indexes.ts";

type AgentUpdate = Extract<EventPayload, { type: "agent.updated" }>;

/** Creates a conservative placeholder instead of discarding early frames. */
export function ensureAgent(
  state: ThreadState,
  key: Key,
  ctx: ApplyContext,
  events: EventPayload[],
): AgentRecord {
  const existing = get(state.agents, key);
  if (existing) return existing;
  const parentKey = state.rootKey;
  const root = parentKey === undefined ? undefined : get(state.agents, parentKey);
  const agent: Agent = {
    id: AgentId.parse(ctx.ids.next("agent")),
    threadId: state.threadId,
    parentId: root?.agent.id ?? null,
    origin: root ? "provider_subagent" : "root",
    native: { provider: root?.agent.native.provider ?? state.config.provider, nativeId: key },
    fidelity: "placeholder",
    cwd: root?.agent.cwd ?? "",
    status: { state: "starting" },
    background: false,
    createdAt: ctx.now,
  };
  const record: AgentRecord = {
    agent,
    activity: "starting_turn",
    lastSignalAt: ctx.now,
    ...(parentKey === undefined ? {} : { parentKey }),
  };
  put(state.agents, key, record);
  refreshAgentIndex(state, key);
  if (state.rootKey === undefined) state.rootKey = key;
  emit(events, { type: "agent.created", agent });
  return record;
}

function changeAgent(
  record: AgentRecord,
  fields: Omit<AgentUpdate, "type" | "agentId">,
  events: EventPayload[],
): void {
  const changed: Omit<AgentUpdate, "type" | "agentId"> = {};
  for (const key of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = fields[key];
    if (value !== undefined && JSON.stringify(record.agent[key]) !== JSON.stringify(value)) {
      Object.assign(changed, { [key]: value });
    }
  }
  if (Object.keys(changed).length === 0) return;
  Object.assign(record.agent, changed);
  emit(events, { type: "agent.updated", agentId: record.agent.id, ...changed });
}

function setParent(
  state: ThreadState,
  key: Key,
  parentKey: Key | undefined,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  const record = ensureAgent(state, key, ctx, events);
  if (parentKey === key) throw new Error("an agent cannot be its own parent");
  const clearsSpawn =
    record.parentKey !== parentKey &&
    (record.spawnedByKey !== undefined || record.agent.spawnedBy != null);
  const spawnFields = clearsSpawn ? { spawnedBy: null } : {};
  if (parentKey !== undefined) {
    const visited = new Set<Key>();
    let ancestor: Key | undefined = parentKey;
    while (ancestor !== undefined && !visited.has(ancestor)) {
      if (ancestor === key) throw new Error("agent links cannot create a cycle");
      visited.add(ancestor);
      ancestor = get(state.agents, ancestor)?.parentKey;
    }
    const parent = ensureAgent(state, parentKey, ctx, events);
    if (clearsSpawn) delete record.spawnedByKey;
    record.parentKey = parentKey;
    const previousParentId = record.agent.parentId;
    changeAgent(record, { parentId: parent.agent.id, ...spawnFields }, events);
    refreshAgentIndex(state, key, previousParentId);
  } else {
    if (clearsSpawn) delete record.spawnedByKey;
    delete record.parentKey;
    const previousParentId = record.agent.parentId;
    changeAgent(record, { parentId: null, ...spawnFields }, events);
    refreshAgentIndex(state, key, previousParentId);
  }
}

function adoptRoot(state: ThreadState, key: Key, ctx: ApplyContext, events: EventPayload[]): void {
  const oldRootKey = state.rootKey;
  state.rootKey = key;
  setParent(state, key, undefined, ctx, events);
  changeAgent(ensureAgent(state, key, ctx, events), { origin: "root" }, events);
  if (oldRootKey !== undefined && oldRootKey !== key) {
    const oldRoot = get(state.agents, oldRootKey);
    if (oldRoot && (oldRoot.agent.fidelity === "placeholder" || oldRoot.agent.origin !== "root")) {
      setParent(state, oldRootKey, key, ctx, events);
      changeAgent(oldRoot, { origin: "provider_subagent" }, events);
    }
  }
}

function ensureParent(
  state: ThreadState,
  key: Key,
  parentKey: Key,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  if (key === parentKey) throw new Error("an agent cannot be its own parent");
  ensureAgent(state, parentKey, ctx, events);
  // The first frame may belong to a child before its real root is known.
  if (state.rootKey === key) adoptRoot(state, parentKey, ctx, events);
}

export function ensureInitialRoot(
  state: ThreadState,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  if (!state.initialRoot) return;
  const initial = state.initialRoot;
  delete state.initialRoot;
  seeAgent(state, { type: "agent.seen", ...initial, origin: "root" }, ctx, events);
}

export function seeAgent(
  state: ThreadState,
  fact: AgentSeenFact,
  ctx: ApplyContext,
  events: EventPayload[],
): AgentRecord {
  // An unknown parent must exist before its child is assigned an ace parent id.
  if (fact.parent !== undefined) ensureParent(state, fact.agent, fact.parent, ctx, events);
  const record = ensureAgent(state, fact.agent, ctx, events);
  if (fact.origin === "root") adoptRoot(state, fact.agent, ctx, events);
  else if (fact.parent !== undefined) setParent(state, fact.agent, fact.parent, ctx, events);
  if (fact.spawnedBy !== undefined) {
    record.spawnedByKey = fact.spawnedBy;
    registerSpawnLink(state, fact.agent, fact.spawnedBy);
  }
  changeAgent(
    record,
    {
      origin: fact.origin,
      ...(fact.lineage === undefined ? {} : { lineage: fact.lineage }),
      fidelity: fact.fidelity,
      native: structuredClone(fact.native),
      cwd: fact.cwd,
      ...(fact.name === undefined ? {} : { name: fact.name }),
      ...(fact.role === undefined ? {} : { role: fact.role }),
      ...(fact.model === undefined ? {} : { model: fact.model }),
      ...(fact.background === undefined ? {} : { background: fact.background }),
    },
    events,
  );
  reconcileLinks(state, ctx, events);
  return record;
}

export function linkAgent(
  state: ThreadState,
  fact: AgentLinkedFact,
  ctx: ApplyContext,
  events: EventPayload[],
): AgentRecord {
  if (fact.parent !== undefined) ensureParent(state, fact.agent, fact.parent, ctx, events);
  const record = ensureAgent(state, fact.agent, ctx, events);
  if (fact.parent !== undefined) setParent(state, fact.agent, fact.parent, ctx, events);
  if (fact.spawnedBy !== undefined) {
    record.spawnedByKey = fact.spawnedBy;
    registerSpawnLink(state, fact.agent, fact.spawnedBy);
  }
  changeAgent(
    record,
    {
      ...(fact.name === undefined ? {} : { name: fact.name }),
      ...(fact.model === undefined ? {} : { model: fact.model }),
      ...(fact.background === undefined ? {} : { background: fact.background }),
    },
    events,
  );
  reconcileLinks(state, ctx, events);
  return record;
}

/** Joins native keys after either side of a link appears, in either order. */
export function reconcileLinks(
  state: ThreadState,
  ctx: ApplyContext,
  events: EventPayload[],
): void {
  for (const [itemKey, agents] of Object.entries(state.indexes.pendingSpawnLinks)) {
    const item = get(state.items, itemKey);
    if (!item) continue;
    for (const key of Object.keys(agents)) {
      const record = get(state.agents, key);
      if (!record || record.spawnedByKey !== itemKey) continue;
      changeAgent(record, { spawnedBy: item.id }, events);
      const links = get(state.itemLinks, itemKey) ?? {};
      if (links.childAgent === undefined) {
        links.childAgent = key;
        put(state.itemLinks, itemKey, links);
        registerItemLink(state, itemKey);
      }
    }
    delete state.indexes.pendingSpawnLinks[itemKey];
  }
  for (const key of Object.keys(state.indexes.pendingItemLinks)) {
    const links = get(state.itemLinks, key);
    if (!links) {
      delete state.indexes.pendingItemLinks[key];
      continue;
    }
    const item = get(state.items, key);
    if (item?.type !== "tool_call") {
      delete state.indexes.pendingItemLinks[key];
      continue;
    }
    const detail = item.call.detail;
    const linkedKey =
      detail.kind === "agent.spawn"
        ? links.childAgent
        : detail.kind === "agent.message"
          ? links.targetAgent
          : undefined;
    if (linkedKey === undefined) {
      delete state.indexes.pendingItemLinks[key];
      continue;
    }
    const linked = ensureAgent(state, linkedKey, ctx, events);
    if (detail.kind === "agent.spawn" && detail.childAgentId !== linked.agent.id) {
      detail.childAgentId = linked.agent.id;
      linked.spawnedByKey = key;
      setParent(state, linkedKey, get(state.indexes.agentKeysById, item.agentId), ctx, events);
      changeAgent(linked, { spawnedBy: item.id }, events);
      emit(events, { type: "item.updated", item });
    } else if (detail.kind === "agent.message" && detail.targetAgentId !== linked.agent.id) {
      detail.targetAgentId = linked.agent.id;
      emit(events, { type: "item.updated", item });
    }
    delete state.indexes.pendingItemLinks[key];
  }
}
