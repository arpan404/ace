import type { ForkPoint, Item, Run } from "@ace/protocol";
import { forkPointOf, sameForkPoint } from "./fork-point.ts";

/*
 * Where editing or retrying a message of the person starts from. Pure over the thread's order.
 * Editing a message goes back to just before it: the main agent's last finished answer ahead of
 * it, which a fork starts from (any provider) and Pi can rewind its own session to (in place).
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

/**
 * Where an edit of the person's message `itemId` continues from; undefined for the thread's
 * first message (nothing comes before it to go back to) or a message not in the order.
 */
export function editPointOf(
  reader: Reader,
  itemId: string,
  rootAgentId: string | undefined,
): EditPoint | undefined {
  if (!rootAgentId) return undefined;
  const at = reader.order.lastIndexOf(itemId);
  const item = at < 0 ? undefined : reader.item(itemId);
  if (item?.type !== "message" || item.role !== "user") return undefined;
  return pointBefore(reader, at, rootAgentId);
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

/** Whether two edit points start from the same place. */
export function sameEditPoint(a: EditPoint | undefined, b: EditPoint | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.piEntry !== b.piEntry) return false;
  return sameForkPoint(a.fork, b.fork);
}

export function sameRetryPoint(a: RetryPoint | undefined, b: RetryPoint | undefined): boolean {
  if (a === b) return true;
  return !!a && !!b && a.askId === b.askId && sameEditPoint(a.point, b.point);
}
