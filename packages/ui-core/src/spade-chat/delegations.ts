import { pluralCount } from "../counts.ts";
import { subagentTerminal, type SubagentState } from "../subagents.ts";
import type { SpadeWorkerNode } from "./workers.ts";

/*
 * The workers a bot starts (ADR 0161), as its chat shows them: one card in the turn that started
 * them, one row per worker, as ace shows a thread's delegated children. What the card says of
 * each comes live from ace (an ace agent's thread) and from the bot's tree; the stored event says
 * only who was started, by which call. Pure.
 */

/** A worker the bot started: an ace agent (its thread's id) or a bot it made. */
export interface SpadeStartedWorker {
  id: string;
  kind: "ace" | "bot";
  name: string;
}

/** The workers one call started, as one entry where the first of them started. */
export interface SpadeWorkersEntry {
  kind: "workers";
  key: string;
  /** The call that started them; empty from a Spade that doesn't say. */
  call: string;
  workers: readonly SpadeStartedWorker[];
  at?: number;
}

/** How far back from the end a later start of the same call looks for its card. */
const joinReach = 6;

/**
 * Add `worker` to the card its call already has near the end of `entries`, in place; false when
 * there is none, so the caller places a new one. A worker started again stays in its place.
 */
export function spadeJoinWorkers(
  entries: ({ kind: string } | SpadeWorkersEntry)[],
  call: string,
  worker: SpadeStartedWorker,
): boolean {
  for (let at = entries.length - 1; at >= 0 && at >= entries.length - joinReach; at--) {
    const card = entries[at];
    if (!card || !isWorkers(card) || card.call !== call) continue;
    const workers = card.workers.some((each) => each.id === worker.id)
      ? card.workers.map((each) => (each.id === worker.id ? worker : each))
      : [...card.workers, worker];
    entries[at] = { ...card, workers };
    return true;
  }
  return false;
}

const isWorkers = (entry: { kind: string }): entry is SpadeWorkersEntry =>
  entry.kind === "workers";

/** An ace child's state in the bot's tree (`AceState`), in ace's words for a delegated child. */
const aceStates: Record<string, SubagentState> = {
  working: "working",
  stopping: "working",
  needs_you: "human",
  limited: "waiting",
  done: "done",
  failed: "failed",
  stopped: "cancelled",
  // Its job was cut off: Spade no longer follows it, so it isn't read as running or as done.
  ended: "cancelled",
};

/**
 * A worker's state as the bot's tree last said it, in ace's words; undefined when the tree
 * doesn't list it. A state a later Spade adds reads as working, never as done.
 */
export function spadeTreeWorkerState(node: SpadeWorkerNode | undefined): SubagentState | undefined {
  if (!node) return undefined;
  if (node.kind === "ace") return aceStates[node.state] ?? "working";
  if (node.needsYou || node.state === "waiting") return "human";
  if (node.queued) return "queued";
  if (node.state === "idle") return "done";
  return "working";
}

/** The tree's node for each of the bot's own workers, by id. */
export function spadeTreeWorkers(
  tree: SpadeWorkerNode | undefined,
): ReadonlyMap<string, SpadeWorkerNode> {
  return new Map((tree?.children ?? []).map((node) => [node.id, node]));
}

/**
 * The card's heading: "Started 4 agents" while any works or waits, "4 agents ran" once all have
 * ended (never while one still runs, AGENTS.md priority 1).
 */
export function spadeWorkersTitle(states: readonly SubagentState[]): string {
  const count = pluralCount(states.length, "agent");
  return states.length > 0 && states.every(subagentTerminal) ? `${count} ran` : `Started ${count}`;
}

/** The workers across the chat's cards that wait on the person now, oldest first, once each. */
export function spadeWaitingWorkers<T extends SpadeStartedWorker>(
  cards: readonly { workers: readonly T[] }[],
  stateOf: (worker: T) => SubagentState,
): T[] {
  const seen = new Set<string>();
  const waiting: T[] = [];
  for (const card of cards)
    for (const worker of card.workers) {
      if (seen.has(worker.id)) continue;
      seen.add(worker.id);
      if (stateOf(worker) === "human") waiting.push(worker);
    }
  return waiting;
}
