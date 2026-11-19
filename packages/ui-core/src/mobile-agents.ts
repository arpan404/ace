import { isInternalTask } from "@ace/projection";
import type { Agent, BackgroundTask, Interaction } from "@ace/protocol";
import type { ThreadReader } from "@ace/client";
import { agentName, agentTreeWork, agentWorkState, taskState } from "./agents.ts";
import { lostChildAsk, type LostChildAsk } from "./lost-child.ts";
import { modelLabel } from "./providers.ts";
import { toneToken, type StatusDisplay, type StatusToken } from "./mobile-status.ts";
import {
  agentNodeIcon,
  agentNodeReason,
  agentTreeSummary,
  ownRequests,
  type AgentNodeIcon,
  type AgentTreeSummary,
} from "./mobile-agent-tree.ts";

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
  /** The provider it runs on (`claude`, `codex`…), for its mark. */
  provider: string;
  /** The model in words ("Opus 5.5"), empty when unknown. */
  modelLabel: string;
  /** What its parent asked it to be ("reviewer"), when the provider says. */
  role: string;
  /** The paired machine it runs on, when that is another one. */
  machine: string | null;
  /** Why it stopped or can't go on ("ran out of usage"), when its status doesn't say. */
  reason: string | null;
  icon: AgentNodeIcon;
  /** Its own requests the person can answer from the tree, oldest first. */
  requests: string[];
  /** A child on another machine whose pairing is gone: the sentence and Stop tracking. */
  lost: LostChildAsk | null;
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
  /** One sentence over the whole tree; never finished while any branch works or waits. */
  summary: AgentTreeSummary;
}

const taskTokens: Record<BackgroundTask["status"], StatusToken> = {
  running: "working",
  unknown: "neutral",
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

/**
 * Agents under each one at any depth that `counts` (still unsettled, for Stop): in depth-first
 * order they follow it until depth returns.
 */
function descendantCounts(
  order: readonly { agent: Agent; depth: number }[],
  counts: (id: string) => boolean,
): Map<string, number> {
  const result = new Map<string, number>();
  // Prefix sums of counted agents, so each subtree's count is one subtraction.
  const before: number[] = [0];
  for (const { agent } of order) before.push((before.at(-1) ?? 0) + (counts(agent.id) ? 1 : 0));
  const open: number[] = [];
  const close = (depth: number, at: number) => {
    for (let top = open.at(-1); top !== undefined; top = open.at(-1)) {
      const entry = order[top];
      if (!entry || entry.depth < depth) return;
      open.pop();
      result.set(entry.agent.id, (before[at] ?? 0) - (before[top + 1] ?? 0));
    }
  };
  order.forEach((entry, index) => {
    close(entry.depth, index);
    open.push(index);
  });
  close(0, order.length);
  return result;
}

/** Tasks' order: running work, then failures, then the rest. */
const taskRank = (task: BackgroundTask) =>
  task.status === "running" ? 2 : task.status === "failed" ? 1 : 0;

const troubled = (agent: Agent) =>
  agent.status.state === "failed" || agent.status.state === "unresponsive";

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
  // The daemon's request about each lost child, by the child's thread, wherever it opened.
  const lost = new Map<string, LostChildAsk>();
  for (const interaction of interactions) {
    const ask = lostChildAsk(interaction);
    if (ask && !lost.has(ask.childThreadId)) lost.set(ask.childThreadId, ask);
  }
  const fresh = reader.unconfirmed !== true && reader.syncing !== true;
  const order = treeOrder(agents);
  // Stop names only the subagents it would stop: those still unsettled.
  const descendants = descendantCounts(order, (id) => work.running.has(id));
  // The first page holds what the person must see first, each with the ancestors that place
  // it in the tree: what waits on them, then what failed or went silent, then what still runs,
  // then the rest. A failure is never pushed behind Show more by agents still at work.
  const byId = new Map(order.map(({ agent }) => [agent.id, agent]));
  const keep = new Set<string>();
  const admit = (agent: Agent) => {
    const chain: string[] = [];
    for (
      let at: Agent | undefined = agent;
      at && !keep.has(at.id);
      at = at.parentId ? byId.get(at.parentId) : undefined
    )
      chain.push(at.id);
    if (keep.size + chain.length > limits.agents) return;
    for (const id of chain) keep.add(id);
  };
  const tiers: ((agent: Agent) => boolean)[] = [
    (agent) => work.needsYou.has(agent.id),
    troubled,
    (agent) => work.running.has(agent.id),
    () => true,
  ];
  for (const tier of tiers)
    for (const { agent } of order) if (keep.size < limits.agents && tier(agent)) admit(agent);

  let tokens: number | null = null;
  let costUsd: number | null = null;
  const rows: AgentSheetRow[] = [];
  let hiddenRunning = 0;
  let asking = 0;
  // Each agent's subagents still at work: what its waiting ring counts.
  const runningChildren = new Map<string, number>();
  for (const { agent } of order)
    if (agent.parentId && work.running.has(agent.id))
      runningChildren.set(agent.parentId, (runningChildren.get(agent.parentId) ?? 0) + 1);
  // The oldest request each branch waits on, so an ancestor's icon says what kind it is.
  const askedBelow = new Map<string, Interaction>();
  for (const interaction of interactions) {
    const asker = byId.get(interaction.agentId);
    if (!asker || ownRequests(asker, [interaction]).length === 0) continue;
    for (
      let at: Agent | undefined = asker;
      at && !askedBelow.has(at.id);
      at = at.parentId ? byId.get(at.parentId) : undefined
    )
      askedBelow.set(at.id, interaction);
  }
  for (const { agent, depth } of order) {
    const own = ownRequests(agent, interactions);
    if (own.length > 0) asking++;
    const usage = reader.usage(agent.id);
    const used = usage ? usage.inputTokens + usage.outputTokens : null;
    if (used !== null) tokens = (tokens ?? 0) + used;
    if (usage?.costUsd !== undefined) costUsd = (costUsd ?? 0) + usage.costUsd;
    if (!keep.has(agent.id)) {
      if (work.running.has(agent.id)) hiddenRunning++;
      continue;
    }
    const state = agentWorkState(agent, work, { fresh });
    const modelId = agent.model ?? usage?.model ?? "";
    const running = work.running.has(agent.id);
    rows.push({
      id: agent.id,
      parentId: agent.parentId,
      depth,
      // An unnamed subagent goes by what the call that started it says it is for.
      name: agentName(agent, agent.spawnedBy ? reader.item(agent.spawnedBy) : undefined),
      model: modelId,
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
      provider: agent.native.provider,
      modelLabel: modelId ? modelLabel(modelId) : "",
      role: agent.role ?? "",
      machine: agent.machine?.name ?? null,
      reason: agentNodeReason(agent),
      icon: agentNodeIcon(
        agent,
        work,
        own[0] ?? askedBelow.get(agent.id),
        runningChildren.get(agent.id) ?? 0,
        fresh,
      ),
      requests: own.map((interaction) => interaction.id),
      lost: (agent.machine && agent.childThreadId && lost.get(agent.childThreadId)) || null,
    });
  }

  // Running work (and work ace lost track of) first, then failures, then the newest that
  // ended; ace's bookkeeping is never listed.
  const listed = tasks.filter((task) => !isInternalTask(task));
  const shownTasks = listed
    .toSorted((a, b) => taskRank(b) - taskRank(a) || b.startedAt - a.startedAt)
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
    summary: agentTreeSummary({ agents, tasks: listed, work, asking, fresh }),
  };
}
