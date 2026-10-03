import type { ForkPoint, Item, Run } from "@ace/protocol";

/**
 * Where a fork of this answer starts: its turn once that turn has finished (any outcome), the
 * message itself when it carries no turn. Undefined while it is still being written. Pure.
 */
export function forkPointOf(item: Item | undefined, run: Run | undefined): ForkPoint | undefined {
  if (item?.type !== "message" || item.role !== "assistant" || !item.complete) return undefined;
  if (item.runId === undefined) return { type: "item", itemId: item.id };
  return run && run.state !== "active" ? { type: "turn", runId: run.id } : undefined;
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
