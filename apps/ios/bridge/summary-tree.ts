import type { Agent, Item } from "@ace/protocol";
import {
  backgroundCommand,
  foldFinished,
  forestRequests,
  forestTally,
  formatSpan,
  holdStoppable,
  rowRequest,
  rowStepItem,
  summaryRow,
  type AgentForestNode,
  type CommandForestNode,
  type ForestNode,
  type ThreadWork,
} from "@ace/ui-core";
import type { Preview } from "./agents.ts";

/*
 * The Summary's agent tree as the phone draws it (ADR 0108): every agent of the thread and of
 * the threads it delegated, at every depth, as flat lines in the web tree's order. A live branch
 * shows and a finished one folds until the person opens or folds it; two or more finished
 * siblings fold into one "N done" line. Each agent row is worded by `summaryRow`, the web's own
 * rules, and carries how its provider mark reads (breathing while live, still while unsure,
 * dimmed once done). Pure: the facts, the person's folds and the clock come in.
 */

/** At most this many lines go to the phone; the rest are counted and live in Agents. */
export const treeLineCap = 150;

export type TreeLine =
  | {
      kind: "agent";
      key: string;
      depth: number;
      name: string;
      /** The paired machine it runs on, when that is another one. */
      machine: string | null;
      step: string;
      tone: "plain" | "needs-you" | "failed";
      folded: string;
      time: string;
      /** Counting while it works: its start, so the shown time can be said again. */
      since: number | null;
      provider: string;
      /** The mark breathes: its branch works or waits and its facts are current. */
      live: boolean;
      /** The mark dims: settled and sure of it. */
      done: boolean;
      /** The name steps back to the muted ink. */
      muted: boolean;
      /** Has children: whether they show; null when it has none. */
      expanded: boolean | null;
      /** What a tap opens; null for the thread's own main agent. */
      open: { threadId: string; agentId: string; childThreadId: string | null } | null;
      /** Stop on a long press: the agent itself, or the task its parent holds for it. */
      stop: { kind: "agent"; agentId: string } | { kind: "task"; taskId: string } | null;
      /** The row read aloud. */
      label: string;
    }
  | {
      kind: "command";
      key: string;
      depth: number;
      command: string;
      /** "running", or "last seen running" while its facts aren't confirmed. */
      state: string;
      time: string;
      since: number;
      stop: { kind: "task"; taskId: string } | null;
      label: string;
    }
  | { kind: "finished"; key: string; depth: number; words: string; expanded: boolean };

export interface TreeFacts {
  viewed: string;
  roots: readonly ForestNode[];
  works: ReadonlyMap<string, ThreadWork>;
  /** The person's folds by row key; a row they never folded keeps its default. */
  folds: ReadonlyMap<string, boolean>;
  now: number;
  /** An agent's name as its row says it, in the thread it lives in. */
  name(threadId: string, agent: Agent): string;
  /** An item of a thread the tree holds, when loaded. */
  item(threadId: string, itemId: string): Item | undefined;
}

export interface SummaryTree {
  /** Agents in the tree, as the section's count. */
  count: number;
  lines: TreeLine[];
  /** Lines past the cap. */
  more: number;
}

const toneOf = (tone: "needs-you" | "failed" | undefined) => tone ?? "plain";

function agentLine(
  node: AgentForestNode,
  depth: number,
  expanded: boolean | undefined,
  facts: TreeFacts,
  requests: ReturnType<typeof forestRequests>,
  preview: Preview,
): TreeLine {
  const { agent } = node;
  const stepItem = rowStepItem(node);
  const row = summaryRow({
    node,
    viewed: facts.viewed,
    request: rowRequest(node, requests),
    tool: stepItem && facts.item(stepItem.threadId, stepItem.itemId),
    spawn: agent.spawnedBy ? facts.item(node.threadId, agent.spawnedBy) : undefined,
    // A dropped connection reaches the tree as unconfirmed facts (`node.stale`).
    fresh: true,
    expanded,
    now: facts.now,
  });
  const name = preview(facts.name(node.threadId, agent) || "Main agent", 128);
  const machine = agent.machine ? preview(agent.machine.name, 128) : null;
  const step = preview(row.step, 256);
  // A child on another machine stops through the work its parent holds for it.
  const stop: Extract<TreeLine, { kind: "agent" }>["stop"] = agent.machine
    ? node.hold && holdStoppable(node.hold)
      ? { kind: "task", taskId: node.hold.id }
      : null
    : row.own && !row.root && node.threadId === facts.viewed
      ? { kind: "agent", agentId: agent.id }
      : null;
  return {
    kind: "agent",
    key: node.key,
    depth,
    name,
    machine,
    step,
    tone: toneOf(row.tone),
    folded: row.folded,
    time: row.time,
    since: node.live && agent.endedAt === undefined && row.time ? agent.createdAt : null,
    provider: agent.native.provider,
    live: node.live && !row.still,
    done: row.done,
    muted: row.muted,
    expanded: expanded ?? null,
    open: row.root
      ? null
      : {
          threadId: node.threadId,
          agentId: agent.id,
          // A child on another machine has no thread here: it opens as its parent's agent.
          childThreadId: agent.machine ? null : (agent.childThreadId ?? null),
        },
    stop,
    label: `${name}${machine ? ` · ${machine}` : ""}: ${step}${row.folded ? ` · ${row.folded}` : ""}`,
  };
}

function commandLine(node: CommandForestNode, depth: number, facts: TreeFacts, preview: Preview) {
  const { task } = node;
  const item = task.toolCallId ? facts.item(node.threadId, task.toolCallId) : undefined;
  const command = preview(backgroundCommand(task, item), 512);
  const end = Math.max(facts.now, task.startedAt);
  const state = node.unconfirmed ? "last seen running" : "running";
  return {
    kind: "command" as const,
    key: node.key,
    depth,
    command,
    state,
    time: end - task.startedAt >= 1000 ? formatSpan(task.startedAt, end) : "",
    since: task.startedAt,
    stop: task.stoppable ? { kind: "task" as const, taskId: task.id } : null,
    label: `$ ${command}: ${state}`,
  };
}

/** The tree's lines, depth first, as the web's tree shows them with the same folds. */
export function summaryTree(facts: TreeFacts, preview: Preview): SummaryTree {
  const requests = forestRequests(facts.works);
  const lines: TreeLine[] = [];
  let more = 0;
  const push = (line: () => TreeLine) => {
    if (lines.length < treeLineCap) lines.push(line());
    else more++;
  };
  // The main agent's row stays open: it is the tree itself, not a branch of it.
  const isOpen = (node: ForestNode, depth: number) =>
    facts.folds.get(node.key) ?? (node.live || depth === 0);
  const visit = (node: ForestNode, depth: number) => {
    const parent = node.children.length > 0;
    const open = parent ? isOpen(node, depth) : undefined;
    push(() =>
      node.kind === "agent"
        ? agentLine(node, depth, open, facts, requests, preview)
        : commandLine(node, depth, facts, preview),
    );
    if (open) walk(node.children, depth + 1, node.key);
  };
  const walk = (nodes: readonly ForestNode[], depth: number, parent?: string) => {
    if (parent === undefined) {
      for (const node of nodes) visit(node, depth);
      return;
    }
    for (const row of foldFinished(parent, nodes)) {
      if (row.kind === "node") {
        visit(row.node, depth);
        continue;
      }
      const shown = facts.folds.get(row.key) ?? false;
      push(() => ({
        kind: "finished",
        key: row.key,
        depth,
        words: `${row.nodes.length} done`,
        expanded: shown,
      }));
      if (shown) for (const node of row.nodes) visit(node, depth);
    }
  };
  walk(facts.roots, 0);
  const total = forestTally(facts.roots);
  return {
    count: total.working + total.done + total.syncing,
    lines,
    more,
  };
}
