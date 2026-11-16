import { z } from "zod";
import { spadeJson, spadeRecord } from "./json.ts";
import { spadeGoalLine, type SpadeGoalProgress } from "./goal.ts";

/*
 * A bot's tree of workers (ADR 0161), as `GET /v1/agents/{id}/tree` answers it: the bots it
 * made, the ace coding agents it started and its helpers, each with its rolled-up state, progress
 * and spend. Helpers stay in the chat, one line each, so the Work tab lists bots and ace agents.
 * Parsed leniently: a node this client can't read is left out with everything under it.
 */

export type SpadeWorkerState = "idle" | "working" | "sleeping" | "waiting";

export interface SpadeWorkerNode {
  kind: "bot" | "helper" | "ace";
  /** A bot's agent id, an ace child's thread id, a helper's job. */
  id: string;
  name: string;
  /** A bot's or helper's conversation. */
  conversation: string | undefined;
  /** Rolled up from everything under it (a bot), or its own (`ace` words for an ace child). */
  state: string;
  status: string | undefined;
  needsYou: boolean;
  progress: SpadeGoalProgress | undefined;
  /** Its own spend; undefined for ace agents, which run on the person's subscriptions. */
  costMicros: number | undefined;
  /** Its spend with everything under it. */
  subtreeCostMicros: number | undefined;
  /** Made past the concurrency setting: it starts as others settle. */
  queued: boolean;
  /** Why it is parked, when it waits on a cap. */
  parked: string | undefined;
  children: readonly SpadeWorkerNode[];
}

const micros = z.number().nonnegative().nullish().catch(undefined);

const nodeShape = z.object({
  kind: z.enum(["bot", "helper", "ace"]),
  id: z.string().min(1),
  name: z.string().nullish().catch(undefined),
  conversation: z.string().nullish().catch(undefined),
  state: z.string().catch("idle"),
  status: z.string().nullish().catch(undefined),
  needs_you: z.boolean().catch(false).default(false),
  progress: z
    .object({
      state: z
        .enum(["none", "working", "checking", "not_yet", "unchecked", "done"])
        .catch("working"),
      items_total: z.number().int().nonnegative().catch(0).default(0),
      items_closed: z.number().int().nonnegative().catch(0).default(0),
      items_verified: z.number().int().nonnegative().catch(0).default(0),
    })
    .nullish()
    .catch(undefined),
  cost_micros: micros,
  subtree_cost_micros: micros,
  queued: z.boolean().catch(false).default(false),
  parked: z.string().nullish().catch(undefined),
  children: z.array(z.unknown()).catch([]).default([]),
});

function readNode(value: unknown, depth: number): SpadeWorkerNode | undefined {
  const parsed = nodeShape.safeParse(value);
  if (!parsed.success || depth > 32) return undefined;
  const node = parsed.data;
  const progress = node.progress;
  return {
    kind: node.kind,
    id: node.id,
    name: node.name || node.id,
    conversation: node.conversation ?? undefined,
    state: node.state,
    status: node.status || undefined,
    needsYou: node.needs_you,
    progress: progress
      ? {
          state: progress.state,
          total: progress.items_total,
          closed: progress.items_closed,
          verified: progress.items_verified,
        }
      : undefined,
    costMicros: node.cost_micros ?? undefined,
    subtreeCostMicros: node.subtree_cost_micros ?? undefined,
    queued: node.queued,
    parked: node.parked || undefined,
    children: node.children.flatMap((child) => {
      const read = readNode(child, depth + 1);
      return read ? [read] : [];
    }),
  };
}

/** `{"tree": Node}`; undefined when it makes no sense. */
export function parseSpadeTree(body: string): SpadeWorkerNode | undefined {
  const record = spadeRecord(spadeJson(body));
  return record ? readNode(record.tree, 0) : undefined;
}

export type SpadeWorkerTone = "needs-you" | "working" | "failed" | "rest";

export interface SpadeWorkerRow {
  node: SpadeWorkerNode;
  /** 0 for the bot's own workers, 1 for theirs, and so on. */
  depth: number;
  /** What it is doing, in words. */
  line: string;
  tone: SpadeWorkerTone;
  /** Its own spend to show, plain; undefined for ace agents and before it spent anything. */
  spendMicros: number | undefined;
  /** Something of it may still run, so Stop means something. */
  running: boolean;
}

const aceLines: Record<string, { line: string; tone: SpadeWorkerTone; running: boolean }> = {
  working: { line: "Working", tone: "working", running: true },
  stopping: { line: "Stopping", tone: "working", running: true },
  needs_you: { line: "Needs you in Threads", tone: "needs-you", running: true },
  limited: { line: "At its usage limit", tone: "needs-you", running: true },
  done: { line: "Done", tone: "rest", running: false },
  failed: { line: "Failed", tone: "failed", running: false },
  stopped: { line: "Stopped", tone: "rest", running: false },
  ended: { line: "Ended", tone: "rest", running: false },
};

function botRow(node: SpadeWorkerNode): Pick<SpadeWorkerRow, "line" | "tone" | "running"> {
  if (node.needsYou || node.state === "waiting")
    return { line: node.status ?? "Needs you", tone: "needs-you", running: true };
  if (node.queued) return { line: "Waiting to start", tone: "rest", running: true };
  if (node.state === "working")
    return {
      line: node.status ?? spadeGoalLine(node.progress) ?? "Working",
      tone: "working",
      running: true,
    };
  if (node.parked) return { line: node.parked, tone: "rest", running: true };
  if (node.state === "sleeping")
    return { line: node.status ?? "Waiting", tone: "rest", running: true };
  // Settled: what its goal's check says, never its own word.
  const goal = node.progress?.state;
  if (goal === "done" || goal === "unchecked" || goal === "not_yet")
    return { line: spadeGoalLine(node.progress) ?? "Finished", tone: "rest", running: false };
  return { line: "Finished, not verified", tone: "rest", running: false };
}

/**
 * The Work tab's workers: every bot and ace agent under the bot, each under its maker, with
 * what it's doing in words and its plain spend. Helpers are left out; they show in the chat.
 */
export function spadeWorkerRows(tree: SpadeWorkerNode | undefined): SpadeWorkerRow[] {
  const rows: SpadeWorkerRow[] = [];
  const walk = (node: SpadeWorkerNode, depth: number) => {
    for (const child of node.children) {
      if (child.kind === "helper") continue;
      const said =
        child.kind === "ace"
          ? (aceLines[child.state] ?? { line: "Working", tone: "working" as const, running: true })
          : botRow(child);
      rows.push({
        node: child,
        depth,
        ...said,
        spendMicros:
          child.kind === "bot" && child.costMicros !== undefined && child.costMicros > 0
            ? child.costMicros
            : undefined,
      });
      walk(child, depth + 1);
    }
  };
  if (tree) walk(tree, 0);
  return rows;
}

/** What the bot's workers spent in all: its subtree's spend less its own. */
export function spadeWorkersSpend(tree: SpadeWorkerNode | undefined): number {
  if (!tree) return 0;
  return Math.max(0, (tree.subtreeCostMicros ?? 0) - (tree.costMicros ?? 0));
}

/** The bots it made, which a delete asks about (stop them, or keep them going). */
export function spadeBotWorkers(tree: SpadeWorkerNode | undefined): SpadeWorkerNode[] {
  return tree?.children.filter((child) => child.kind === "bot") ?? [];
}
