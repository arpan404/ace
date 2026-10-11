import type { ThreadReader } from "@ace/client";
import type { Agent, Item, ProviderKind } from "@ace/protocol";
import {
  agentName,
  delegatedState,
  rollupSubagent,
  subagentState,
  subagentTerminal,
  type SubagentState,
} from "@ace/ui-core";
import { AgentFacts } from "@/lib/agent-facts.ts";
import type { Watched } from "@/lib/use-watched.ts";

export interface SubagentEntry {
  id: string;
  agentId?: string | undefined;
  childThreadId?: string | undefined;
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  title: string;
  state: SubagentState;
  startedAt: number;
  endedAt?: number | undefined;
}

type Launch = Extract<Item, { type: "delegation.started" }>;
type Spawn = Extract<Item, { type: "tool_call" }>;

/** Canonical launch links, including agents linked after the spawn item was first streamed. */
export function readSubagentGroup(
  reader: ThreadReader,
  itemIds: readonly string[],
  facts = new AgentFacts(reader),
): Watched<readonly SubagentEntry[]> {
  const launches = new Map<string, Launch>();
  const spawns = new Map<string, Spawn>();
  for (const id of itemIds) {
    const item = reader.item(id);
    if (item?.type === "delegation.started") launches.set(item.childThreadId, item);
    else if (item?.type === "tool_call" && item.call.kind === "agent.spawn") spawns.set(id, item);
  }
  const roots: { agent?: Agent; spawn?: Spawn; launch?: Launch; id: string }[] = [];
  const added = new Set<string>();
  const add = (agent?: Agent, spawn?: Spawn, launch?: Launch) => {
    launch ??= agent?.childThreadId ? launches.get(agent.childThreadId) : undefined;
    const id = launch?.childThreadId ?? agent?.id ?? spawn?.id;
    if (!id || added.has(id)) return;
    added.add(id);
    roots.push({
      id,
      ...(agent ? { agent } : {}),
      ...(spawn ? { spawn } : {}),
      ...(launch ? { launch } : {}),
    });
  };
  for (const id of itemIds) {
    const spawn = spawns.get(id);
    const item = reader.item(id);
    if (item?.type === "delegation.started")
      add(
        reader.agent([...(facts.byThread.get(item.childThreadId) ?? [])][0] ?? ""),
        undefined,
        item,
      );
    if (!spawn) continue;
    const linked = [...(facts.bySpawn.get(id) ?? [])].flatMap((agentId) => {
      const agent = reader.agent(agentId);
      return agent ? [agent] : [];
    });
    const childId =
      spawn.call.detail.kind === "agent.spawn" ? spawn.call.detail.childAgentId : undefined;
    const child = childId ? reader.agent(childId) : undefined;
    if (child && !linked.some((agent) => agent.id === child.id)) linked.push(child);
    if (linked.length) for (const agent of linked) add(agent, spawn);
    else add(undefined, spawn);
  }
  // A nested launch belongs to the branch already listed, rather than counting that branch twice.
  const rootIds = new Set(roots.flatMap((root) => (root.agent ? [root.agent.id] : [])));
  const direct = roots.filter((root) => {
    let parent = root.agent?.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (rootIds.has(parent)) return false;
      visited.add(parent);
      parent = reader.agent(parent)?.parentId;
    }
    return true;
  });
  // Descendants are read once per status/entity change, never by a clock tick or text delta.
  const watched = new Set<string>();
  const collect = (id: string) => {
    if (watched.has(id)) return;
    watched.add(id);
    for (const child of reader.children(id)) collect(child);
  };
  for (const root of direct) if (root.agent) collect(root.agent.id);
  const cached = new Map<string, { state: SubagentState; end?: number }>();
  const visiting = new Set<string>();
  const branch = (id: string): { state: SubagentState; end?: number } => {
    const previous = cached.get(id);
    if (previous) return previous;
    const agent = reader.agent(id);
    if (!agent || visiting.has(id)) return { state: "working" };
    visiting.add(id);
    let state: SubagentState = facts.actionable(id) ? "human" : subagentState(agent.status);
    let end = agent.endedAt ?? facts.endedAt(id);
    for (const child of reader.children(id)) {
      const below = branch(child);
      state = rollupSubagent(state, below.state);
      if (below.end !== undefined) end = Math.max(end ?? below.end, below.end);
    }
    visiting.delete(id);
    const result = { state, ...(end === undefined ? {} : { end }) };
    cached.set(id, result);
    return result;
  };
  const value = direct.map(({ id, agent, spawn, launch }): SubagentEntry => {
    const subtree = agent ? branch(agent.id) : undefined;
    let state = subtree?.state ?? "working";
    if (launch) {
      let launched = delegatedState(launch.status);
      if (launch.phase === "cancelling" && subagentTerminal(launched)) launched = "working";
      else if (subagentTerminal(launched) && launch.outcome?.outcome === "cancelled")
        launched = "cancelled";
      state = subtree ? rollupSubagent(state, launched) : launched;
    } else if (!agent && spawn) {
      if (spawn.call.status === "awaiting_approval") state = "human";
      else if (spawn.call.status === "failed") state = "failed";
      else if (spawn.call.status === "declined" || spawn.call.status === "cancelled")
        state = "cancelled";
    }
    const end =
      launch && subagentTerminal(state)
        ? Math.max(launch.updatedAt, subtree?.end ?? 0)
        : subtree?.end;
    return {
      id,
      agentId: agent?.id,
      childThreadId: launch?.childThreadId ?? agent?.childThreadId,
      provider: launch?.provider ?? agent?.native.provider,
      model: launch?.model ?? agent?.model,
      title: launch?.title ?? (agent ? agentName(agent) : (spawn?.call.title ?? "Subagent")),
      state,
      startedAt: launch?.createdAt ?? agent?.createdAt ?? spawn?.createdAt ?? 0,
      endedAt: subagentTerminal(state) ? (end ?? spawn?.call.endedAt) : undefined,
    };
  });
  return {
    value,
    watch: [
      ...itemIds.map((id) => `item:${id}`),
      ...[...watched].map((id) => `agent:${id}`),
      ...[...watched].flatMap((id) => [`attention:${id}`, `end:${id}`]),
      ...itemIds.map((id) => `spawn:${id}`),
      ...[...launches.keys()].map((id) => `childThread:${id}`),
      ...[...spawns.values()].flatMap((spawn) =>
        spawn.call.detail.kind === "agent.spawn" && spawn.call.detail.childAgentId
          ? [`agent:${spawn.call.detail.childAgentId}`]
          : [],
      ),
    ],
  };
}

export function subagentEntriesEqual(
  a: readonly SubagentEntry[],
  b: readonly SubagentEntry[],
): boolean {
  return (
    a.length === b.length &&
    a.every((entry, at) => {
      const other = b[at];
      return (
        !!other &&
        entry.id === other.id &&
        entry.agentId === other.agentId &&
        entry.childThreadId === other.childThreadId &&
        entry.provider === other.provider &&
        entry.model === other.model &&
        entry.title === other.title &&
        entry.state === other.state &&
        entry.startedAt === other.startedAt &&
        entry.endedAt === other.endedAt
      );
    })
  );
}

/** Result rows can use the parent's canonical launch even when the child is outside the sidebar page. */
export function readSubagentResults(
  reader: ThreadReader,
  threadIds: ReadonlySet<string>,
  facts = new AgentFacts(reader),
): Watched<readonly SubagentEntry[]> {
  const itemIds = new Set<string>();
  for (const threadId of threadIds) {
    for (const id of facts.launches.get(threadId) ?? []) itemIds.add(id);
    for (const id of facts.byThread.get(threadId) ?? []) {
      const agent = reader.agent(id);
      if (agent?.spawnedBy) itemIds.add(agent.spawnedBy);
    }
  }
  const result = readSubagentGroup(reader, [...itemIds], facts);
  return {
    value: result.value,
    watch: [
      ...result.watch,
      ...[...threadIds].flatMap((id) => [`launch:${id}`, `childThread:${id}`]),
    ],
  };
}
