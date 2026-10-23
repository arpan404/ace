import type { ForkPoint, Item, Run } from "@ace/protocol";

/**
 * Where a fork of this answer starts: its turn once that turn has finished (any outcome), the
 * message itself when it carries no turn. Undefined while it is still being written, and for a
 * fork's copy of its source's answer: that one forks from the source. Pure.
 */
export function forkPointOf(item: Item | undefined, run: Run | undefined): ForkPoint | undefined {
  if (item?.type !== "message" || item.role !== "assistant" || !item.complete) return undefined;
  if (item.inherited) return undefined;
  if (item.runId === undefined) return { type: "item", itemId: item.id };
  return run && run.state !== "active" ? { type: "turn", runId: run.id } : undefined;
}

/** Whether two fork points are the same turn or the same message. */
export function sameForkPoint(a: ForkPoint | undefined, b: ForkPoint | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type === "turn") return b.type === "turn" && a.runId === b.runId;
  return b.type === "item" && a.itemId === b.itemId;
}

interface Reader {
  readonly order: readonly string[];
  item(id: string): Item | undefined;
  run(id: string): Run | undefined;
}

/** The newest answer of the main agent that a fork can start from. */
export function latestForkPoint(
  reader: Reader,
  rootAgentId: string | undefined,
): ForkPoint | undefined {
  for (let at = reader.order.length - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (!item || item.agentId !== rootAgentId) continue;
    const point = forkPointOf(item, item.runId === undefined ? undefined : reader.run(item.runId));
    if (point) return point;
  }
  return undefined;
}

/**
 * The newest finished turn of the main agent, whatever its outcome: where a thread continued in
 * another one starts, so a failed or stopped last turn carries over too.
 */
export function latestFinishedTurn(
  reader: Reader,
  rootAgentId: string | undefined,
): ForkPoint | undefined {
  for (let at = reader.order.length - 1; at >= 0; at--) {
    const item = reader.item(reader.order[at] ?? "");
    if (!item || item.agentId !== rootAgentId || item.runId === undefined) continue;
    const run = reader.run(item.runId);
    if (run && run.state !== "active" && run.endedAt !== undefined)
      return { type: "turn", runId: run.id };
  }
  return undefined;
}
