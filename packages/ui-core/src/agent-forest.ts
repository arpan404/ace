import type { Agent, BackgroundTask, Interaction, ThreadStatus } from "@ace/protocol";
import { agentRuns } from "./agent-runs.ts";
import { agentTreeWork } from "./agents.ts";

/*
 * The agent tree across threads (ADR 0107). A thread's agents form a tree by `parentId`; an
 * agent whose work is a delegated thread of its own (`childThreadId`) carries that thread's tree
 * under it, and so on down. Each thread's facts come from its own subscription; this module only
 * joins them. Pure: no clocks, no I/O.
 */

/** One thread's live entities, as a subscription reads them. */
export interface ThreadWork {
  agents: readonly Agent[];
  tasks: readonly BackgroundTask[];
  /** Pending requests only. */
  interactions: readonly Interaction[];
  status?: ThreadStatus | undefined;
}

interface NodeBase {
  /** Unique across threads: `thread/agent` or `thread/task:id`. */
  key: string;
  /** The thread this row's entity lives in. */
  threadId: string;
  /** It, or anything under it in any thread, works or waits. */
  live: boolean;
  /** It, or anything under it in any thread, waits on the person. */
  needsYou: boolean;
  children: ForestNode[];
}

export interface AgentForestNode extends NodeBase {
  kind: "agent";
  agent: Agent;
  /** The delegated thread whose agents hang under it, once loaded. */
  childThread?: string | undefined;
  /** That thread's main agent, whose own requests and state this row speaks for. */
  childRoot?: string | undefined;
}

export interface CommandForestNode extends NodeBase {
  kind: "command";
  task: BackgroundTask;
}

export type ForestNode = AgentForestNode | CommandForestNode;

export interface AgentForest {
  /** The viewed thread's root agents, its main agent first. */
  roots: ForestNode[];
  /** Delegated threads the tree reaches within its bounds, shallowest first: what to load. */
  reach: string[];
}

/**
 * How far the tree follows delegation. Each delegated thread costs one live subscription, and the
 * client keeps at most 32 (types.ts `threads`), shared with every other open view: six levels and
 * sixteen threads show any real delegation chain while leaving room for the rest of the app.
 * Deeper or further threads still show as their delegate's row, only without their own agents.
 */
export const forestBounds = { depth: 6, threads: 16 } as const;

const runningTask = (task: BackgroundTask) =>
  !task.internal && (task.status === "running" || task.status === "unknown");

/**
 * The delegated threads to load, breadth first from `root`: never one already reached (a cycle
 * or a thread delegated twice), never deeper than `bounds.depth`, at most `bounds.threads`.
 */
function reachable(
  root: string,
  works: ReadonlyMap<string, ThreadWork>,
  bounds: { depth: number; threads: number },
): string[] {
  const seen = new Set([root]);
  const reach: string[] = [];
  let level = [root];
  for (let depth = 1; depth <= bounds.depth && level.length; depth++) {
    const next: string[] = [];
    for (const threadId of level)
      for (const agent of works.get(threadId)?.agents ?? []) {
        const child = agent.childThreadId;
        if (!child || seen.has(child) || reach.length >= bounds.threads) continue;
        seen.add(child);
        reach.push(child);
        next.push(child);
      }
    level = next;
  }
  return reach;
}

/**
 * Join each thread's agents into one tree. An earlier run of an agent a provider started again
 * folds into its latest run (its subagents move under it), as the thread's own tree does. Every
 * node is live while anything under it at any depth works or waits, so a branch never reads done
 * while a delegated great-grandchild still runs. A thread shows once, under the first delegate
 * that reaches it, which also ends any cycle. Linear in the agents and tasks of the joined threads.
 */
export function agentForest(
  root: string,
  works: ReadonlyMap<string, ThreadWork>,
  bounds: { depth: number; threads: number } = forestBounds,
): AgentForest {
  const reach = reachable(root, works, bounds);
  const allowed = new Set(reach);
  const placed = new Set<string>([root]);
  const build = (threadId: string): ForestNode[] => {
    const facts = works.get(threadId);
    if (!facts) return [];
    const work = agentTreeWork(facts.agents, facts.tasks, facts.interactions, facts.status);
    const runs = agentRuns(facts.agents);
    const byId = new Map(facts.agents.map((agent) => [agent.id, agent]));
    // An earlier run's row goes when its latest run is here; its subagents follow the latest.
    const shown = (id: string) => {
      const latest = runs.latest.get(id);
      return latest === undefined || !byId.has(latest) ? id : latest;
    };
    const kids = new Map<string | null, Agent[]>();
    for (const agent of facts.agents) {
      if (shown(agent.id) !== agent.id) continue;
      const parent = agent.parentId && byId.has(agent.parentId) ? shown(agent.parentId) : null;
      kids.set(parent, [...(kids.get(parent) ?? []), agent]);
    }
    const commands = new Map<string, BackgroundTask[]>();
    for (const task of facts.tasks)
      if (runningTask(task)) {
        const owner = byId.has(task.agentId) ? shown(task.agentId) : task.agentId;
        commands.set(owner, [...(commands.get(owner) ?? []), task]);
      }
    const visiting = new Set<string>();
    const node = (agent: Agent): AgentForestNode => {
      visiting.add(agent.id);
      const children: ForestNode[] = (kids.get(agent.id) ?? [])
        .filter((child) => !visiting.has(child.id))
        .toSorted((left, right) => left.createdAt - right.createdAt)
        .map(node);
      for (const task of commands.get(agent.id) ?? [])
        children.push({
          kind: "command",
          key: `${threadId}/task:${task.id}`,
          threadId,
          task,
          live: true,
          needsYou: false,
          children: [],
        });
      visiting.delete(agent.id);
      const child = agent.childThreadId;
      let childThread: string | undefined;
      let childRoot: AgentForestNode | undefined;
      if (child && allowed.has(child) && !placed.has(child) && works.has(child)) {
        placed.add(child);
        childThread = child;
        // The delegated thread's main agent is this row's own work: its agents hang here.
        for (const top of build(child))
          if (top.kind === "agent" && top.agent.origin === "root" && !childRoot) {
            childRoot = top;
            children.push(...top.children);
          } else children.push(top);
      }
      return {
        kind: "agent",
        key: `${threadId}/${agent.id}`,
        threadId,
        agent,
        childThread,
        childRoot: childRoot?.agent.id,
        live:
          work.running.has(agent.id) ||
          childRoot?.live === true ||
          children.some((entry) => entry.live),
        needsYou:
          work.needsYou.has(agent.id) ||
          childRoot?.needsYou === true ||
          children.some((entry) => entry.needsYou),
        children,
      };
    };
    const tops = (kids.get(null) ?? []).toSorted(
      (left, right) =>
        Number(right.origin === "root") - Number(left.origin === "root") ||
        left.createdAt - right.createdAt,
    );
    return tops.map(node);
  };
  return { roots: build(root), reach };
}

/** What a branch holds below its row, at any depth. */
export interface ForestTally {
  /** Agents still working or waiting. */
  working: number;
  /** Agents whose whole branch settled. */
  done: number;
  /** Background commands still running. */
  commands: number;
}

export function forestTally(nodes: readonly ForestNode[]): ForestTally {
  const tally: ForestTally = { working: 0, done: 0, commands: 0 };
  const walk = (list: readonly ForestNode[]) => {
    for (const entry of list) {
      if (entry.kind === "command") tally.commands++;
      else if (entry.live) tally.working++;
      else tally.done++;
      walk(entry.children);
    }
  };
  walk(nodes);
  return tally;
}

/** A folded branch in words: "2 working · 1 done", "1 command". */
export function foldWords(tally: ForestTally): string {
  const words: string[] = [];
  if (tally.working) words.push(`${tally.working} working`);
  if (tally.done) words.push(`${tally.done} done`);
  if (tally.commands)
    words.push(`${tally.commands} ${tally.commands === 1 ? "command" : "commands"}`);
  return words.join(" · ");
}

/**
 * The agent the person is needed by: the deepest row on the first branch waiting on them, so the
 * Summary names the agent that asks rather than the parents waiting on it.
 */
export function forestAsker(nodes: readonly ForestNode[]): AgentForestNode | undefined {
  const first = nodes.find(
    (entry): entry is AgentForestNode => entry.kind === "agent" && entry.needsYou,
  );
  if (!first) return undefined;
  return forestAsker(first.children) ?? first;
}

/** Every row's key, for a lookup of which rows exist. */
export function forestKeys(nodes: readonly ForestNode[]): Set<string> {
  const keys = new Set<string>();
  const walk = (list: readonly ForestNode[]) => {
    for (const entry of list) {
      keys.add(entry.key);
      walk(entry.children);
    }
  };
  walk(nodes);
  return keys;
}
