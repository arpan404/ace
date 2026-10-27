import { isInternalTask } from "@ace/projection";
import type { Agent, BackgroundTask, Interaction } from "@ace/protocol";
import type { ThreadReader } from "@ace/client";
import { agentName, agentTreeWork, agentWorkState, taskState } from "./agents.ts";
import { toneToken, type StatusDisplay, type StatusToken } from "./mobile-status.ts";

/*
 * The native apps' Agents sheet (issue #560, item 5): the whole agent tree in depth-first order
 * with each agent's tree-aware status, its usage, and the thread's background work. Pure: it
 * reads one thread through the SDK's reader. Large trees are read a page at a time, never
 * silently cut: an agent that is still working or waiting on the person, or one of its
 * ancestors, is kept over a finished one, and every agent or task not yet shown is counted so
 * the sheet can offer the next page.
 */

export interface AgentSheetLimits {
  agents: number;
  tasks: number;
}
export const agentSheetLimits: AgentSheetLimits = { agents: 100, tasks: 30 };

/**
 * The limits after the person asked for `pages` more of each list: every page adds one first
 * page's worth, so a large tree is read a page at a time and never all at once.
 */
export function agentSheetPages(
  pages: { agents: number; tasks: number },
  first: AgentSheetLimits = agentSheetLimits,
): AgentSheetLimits {
  return {
    agents: first.agents * (1 + Math.max(0, pages.agents)),
    tasks: first.tasks * (1 + Math.max(0, pages.tasks)),
  };
}

export interface AgentSheetRow {
  id: string;
  parentId: string | null;
  /** 0 for the root; children of a hidden agent keep their own depth. */
  depth: number;
  name: string;
  model: string;
  status: StatusDisplay;
  /** What it is doing, in the tree's quiet phrasing ("waiting for subagents"). */
  activity: string;
  /** Unsettled: it, a descendant or its background work is still going. */
  running: boolean;
  needsYou: boolean;
  /** Input plus output tokens the provider reported, when it reports usage. */
  tokens: number | null;
  costUsd: number | null;
  /** An independent ace thread this agent summarizes, opened as its own thread. */
  childThreadId: string | null;
  /** Agents under it at any depth: Stop stops them too. */
  descendants: number;
  /** A person may stop this agent (and its descendants) on its own. The root stops the tree. */
  stoppable: boolean;
  background: boolean;
  createdAt: number;
  endedAt: number | null;
}

export interface TaskSheetRow {
  id: string;
  agentId: string;
  kind: BackgroundTask["kind"];
  title: string;
  status: StatusDisplay;
  stoppable: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface AgentSheet {
  rows: AgentSheetRow[];
  /** Agents beyond the cap, and how many of those are still working. */
  hidden: { agents: number; running: number };
  tasks: TaskSheetRow[];
  hiddenTasks: number;
  totals: {
    agents: number;
    running: number;
    needsYou: number;
    tokens: number | null;
    costUsd: number | null;
  };
  /** The root agent's context meter, when the provider reports one. */
  context: { used: number; window: number } | null;
  /** Something in the tree is still unsettled, so Stop all has work to stop. */
  treeRunning: boolean;
}

const taskTokens: Record<BackgroundTask["status"], StatusToken> = {
  running: "working",
  unknown: "waiting",
  completed: "done",
  failed: "failed",
  stopped: "neutral",
};

function collect<T>(ids: readonly string[], read: (id: string) => T | undefined): T[] {
  const out: T[] = [];
  for (const id of ids) {
    const value = read(id);
    if (value) out.push(value);
  }
  return out;
}

/** Depth-first from each root (an agent with no parent, or whose parent isn't held). */
function treeOrder(agents: readonly Agent[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const children = new Map<string, Agent[]>();
  for (const agent of agents)
    if (agent.parentId && byId.has(agent.parentId)) {
      const siblings = children.get(agent.parentId) ?? [];
      siblings.push(agent);
      children.set(agent.parentId, siblings);
    }
  const roots = agents
    .filter((agent) => !agent.parentId || !byId.has(agent.parentId))
    .toSorted(
      (a, b) =>
        Number(b.origin === "root") - Number(a.origin === "root") || a.createdAt - b.createdAt,
    );
  const order: { agent: Agent; depth: number }[] = [];
  const seen = new Set<string>();
  // An explicit stack: a deep chain of subagents must not exhaust the JS stack.
  const stack = roots.toReversed().map((agent) => ({ agent, depth: 0 }));
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (seen.has(next.agent.id)) continue;
    seen.add(next.agent.id);
    order.push(next);
    const own = (children.get(next.agent.id) ?? []).toSorted((a, b) => b.createdAt - a.createdAt);
    for (const child of own) stack.push({ agent: child, depth: next.depth + 1 });
  }
  return order;
}

/** Agents under each one at any depth: in depth-first order they follow it until depth returns. */
function descendantCounts(order: readonly { agent: Agent; depth: number }[]): Map<string, number> {
  const counts = new Map<string, number>();
  const open: number[] = [];
  const close = (depth: number, at: number) => {
    for (let top = open.at(-1); top !== undefined; top = open.at(-1)) {
      const entry = order[top];
      if (!entry || entry.depth < depth) return;
      open.pop();
      counts.set(entry.agent.id, at - top - 1);
    }
  };
  order.forEach((entry, index) => {
    close(entry.depth, index);
    open.push(index);
  });
  close(0, order.length);
  return counts;
}

/** The sheet for one thread, read fresh: cost is proportional to the tree, never to history. */
export function agentSheet(
  reader: Pick<
    ThreadReader,
    | "thread"
    | "context"
    | "unconfirmed"
    | "syncing"
    | "agentIds"
    | "agent"
    | "taskIds"
    | "task"
    | "interactionIds"
    | "interaction"
    | "usage"
    | "item"
  >,
  limits: AgentSheetLimits = agentSheetLimits,
): AgentSheet {
  const agents = collect(reader.agentIds(), (id) => reader.agent(id));
  const tasks = collect(reader.taskIds(), (id) => reader.task(id));
  const interactions = collect(reader.interactionIds(), (id) => reader.interaction(id)).filter(
    (interaction: Interaction) => interaction.state === "pending",
  );
  const work = agentTreeWork(agents, tasks, interactions, reader.thread?.status);
  const fresh = reader.unconfirmed !== true && reader.syncing !== true;
  const order = treeOrder(agents);
  const descendants = descendantCounts(order);
  // Unsettled agents (and so their ancestors, which `work` already includes) win the cap.
  const keep = new Set<string>();
  for (const { agent } of order)
    if (keep.size < limits.agents && (work.running.has(agent.id) || work.needsYou.has(agent.id)))
      keep.add(agent.id);
  for (const { agent } of order) if (keep.size < limits.agents) keep.add(agent.id);

  let tokens: number | null = null;
  let costUsd: number | null = null;
  const rows: AgentSheetRow[] = [];
  let hiddenRunning = 0;
  for (const { agent, depth } of order) {
    const usage = reader.usage(agent.id);
    const used = usage ? usage.inputTokens + usage.outputTokens : null;
    if (used !== null) tokens = (tokens ?? 0) + used;
    if (usage?.costUsd !== undefined) costUsd = (costUsd ?? 0) + usage.costUsd;
    if (!keep.has(agent.id)) {
      if (work.running.has(agent.id)) hiddenRunning++;
      continue;
    }
    const state = agentWorkState(agent, work, { fresh });
    const running = work.running.has(agent.id);
    rows.push({
      id: agent.id,
      parentId: agent.parentId,
      depth,
      // An unnamed subagent goes by what the call that started it says it is for.
      name: agentName(agent, agent.spawnedBy ? reader.item(agent.spawnedBy) : undefined),
      model: agent.model ?? usage?.model ?? "",
      status: { label: state.label, token: toneToken(state.tone) },
      activity: state.activity,
      running,
      needsYou: work.needsYou.has(agent.id),
      tokens: used,
      costUsd: usage?.costUsd ?? null,
      childThreadId: agent.childThreadId ?? null,
      descendants: descendants.get(agent.id) ?? 0,
      stoppable: agent.origin !== "root" && running,
      background: agent.background,
      createdAt: agent.createdAt,
      endedAt: agent.endedAt ?? null,
    });
  }

  // Running work first, then the newest that ended; ace's bookkeeping is never listed.
  const listed = tasks.filter((task) => !isInternalTask(task));
  const shownTasks = listed
    .toSorted(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.startedAt - a.startedAt,
    )
    .slice(0, limits.tasks);
  const meter = reader.context;
  return {
    rows,
    hidden: { agents: order.length - rows.length, running: hiddenRunning },
    tasks: shownTasks.map((task) => ({
      id: task.id,
      agentId: task.agentId,
      kind: task.kind,
      title: task.title,
      status: { label: taskState(task), token: taskTokens[task.status] },
      stoppable: task.stoppable && task.status === "running",
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
    })),
    hiddenTasks: listed.length - shownTasks.length,
    totals: {
      agents: order.length,
      running: order.filter(({ agent }) => work.running.has(agent.id)).length,
      needsYou: order.filter(({ agent }) => work.needsYou.has(agent.id)).length,
      tokens,
      costUsd,
    },
    context:
      meter && meter.usedTokens !== null && meter.windowTokens !== null
        ? { used: meter.usedTokens, window: meter.windowTokens }
        : null,
    treeRunning: work.running.size > 0,
  };
}
