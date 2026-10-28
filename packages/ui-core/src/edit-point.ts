import type { ForkPoint, Item, Run } from "@ace/protocol";
import { forkPointOf, sameForkPoint } from "./fork-point.ts";

/*
 * Where retrying the person's last ask starts from. Pure over the thread's order. It goes back to
 * just before the ask: the main agent's last finished answer ahead of it, which Pi can rewind its
 * own session to (in place).
 */

interface Reader {
  readonly order: readonly string[];
  item(id: string): Item | undefined;
  run(id: string): Run | undefined;
}

/** The point just before a message: where a fork starts, and Pi's native entry when it has one. */
export interface EditPoint {
  fork: ForkPoint;
  /** The answer's Pi session entry: a rewind there continues right before the message. */
  piEntry: string | undefined;
}

/** An answer Pi wrote (or one with no recorded source, which ran on the thread's provider). */
const isPi = (item: Item) => (item.executionSource?.selection.provider ?? "pi") === "pi";

/** The main agent's newest finished answer before position `before` in the order. */
function pointBefore(reader: Reader, before: number, rootAgentId: string): EditPoint | undefined {
  for (let at = before - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (!item || item.agentId !== rootAgentId) continue;
    const fork = forkPointOf(item, item.runId === undefined ? undefined : reader.run(item.runId));
    if (!fork) continue;
    return { fork, piEntry: isPi(item) && item.nativeId ? item.nativeId : undefined };
  }
  return undefined;
}

/** A retry of the newest answer: the message that asked for it, sent again from before it. */
export interface RetryPoint {
  askId: string;
  point: EditPoint;
}

/**
 * Retrying answer `itemId`: only the main agent's newest finished answer, by asking again what
 * the person last asked from just before that ask. Undefined for any other answer, one still
 * being written, or when nothing finished comes before the ask.
 */
export function retryPointOf(
  reader: Reader,
  itemId: string,
  rootAgentId: string | undefined,
): RetryPoint | undefined {
  if (!rootAgentId) return undefined;
  let answerAt = -1;
  for (let at = reader.order.length - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (!item || item.agentId !== rootAgentId || item.type !== "message") continue;
    if (item.role === "assistant") {
      // A newer answer of the main agent, or a turn still writing this one: not the newest.
      if (item.id !== itemId) return undefined;
      const run = item.runId === undefined ? undefined : reader.run(item.runId);
      if (!forkPointOf(item, run)) return undefined;
      answerAt = at;
      break;
    }
    // The person spoke after the answer: it no longer answers the latest ask.
    if (item.role === "user") return undefined;
  }
  for (let at = answerAt - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (item?.type !== "message" || item.role !== "user") continue;
    const point = pointBefore(reader, at, rootAgentId);
    return point && { askId: item.id, point };
  }
  return undefined;
}

/** Whether two points start from the same place. */
function sameEditPoint(a: EditPoint | undefined, b: EditPoint | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.piEntry !== b.piEntry) return false;
  return sameForkPoint(a.fork, b.fork);
}

export function sameRetryPoint(a: RetryPoint | undefined, b: RetryPoint | undefined): boolean {
  if (a === b) return true;
  return !!a && !!b && a.askId === b.askId && sameEditPoint(a.point, b.point);
}

/**
 * Editing the person's message `messageId`: a fork from just before it (the main agent's newest
 * finished answer ahead of it), whose first message is the edited words. Undefined for anything
 * but the person's message, and for one with no finished answer before it (the thread's opening).
 */
export function editPointOf(
  reader: Reader,
  messageId: string,
  rootAgentId: string | undefined,
  /** The message's place in `reader.order`; the caller knows it, so nothing scans for it. */
  at: number,
): EditPoint | undefined {
  if (!rootAgentId || at < 0 || reader.order[at] !== messageId) return undefined;
  const item = reader.item(messageId);
  if (item?.type !== "message" || item.role !== "user" || item.synthetic) return undefined;
  return pointBefore(reader, at, rootAgentId);
}

/**
 * What a fork brings back to its parent: its main agent's newest finished answer of its own work.
 * What the fork copied from its parent (`inherited`) is not its own work.
 */
export function mergeAnswerOf(
  reader: Reader,
  rootAgentId: string | undefined,
): Extract<Item, { type: "message" }> | undefined {
  if (!rootAgentId) return undefined;
  for (let at = reader.order.length - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (
      item?.type === "message" &&
      item.role === "assistant" &&
      item.complete &&
      !item.synthetic &&
      !item.inherited &&
      item.agentId === rootAgentId
    )
      return item;
  }
  return undefined;
}

/** The answer's words as a merge summary starts out, bounded to what a message carries. */
export function mergeSummaryOf(
  answer: Extract<Item, { type: "message" }> | undefined,
  limit: number,
): string {
  return (
    answer?.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
      .slice(0, limit) ?? ""
  );
}

/** Why a fork's work can't go back to its parent yet, in the words the bring-back form shows. */
export const bringBackWaits = {
  working: "Wait for every agent in this fork to finish before bringing its work back.",
  answer: "Wait for an answer in this fork before bringing results back.",
} as const;

/**
 * Whether this fork's work can go back to its parent now: only once its whole tree has finished
 * (the daemon refuses a live one) and it has an answer of its own to send. `state` is the fork's
 * whole-tree status.
 */
export function bringBackOf(
  reader: Reader,
  rootAgentId: string | undefined,
  state: string | undefined,
): { answer: Extract<Item, { type: "message" }> } | { refused: string } {
  if (state !== "done" && state !== "failed") return { refused: bringBackWaits.working };
  const answer = mergeAnswerOf(reader, rootAgentId);
  return answer ? { answer } : { refused: bringBackWaits.answer };
}
