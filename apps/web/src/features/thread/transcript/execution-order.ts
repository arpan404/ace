import type { Item, Run } from "@ace/protocol";

/** Admission precedes execution. Place a turn's admitted ask beside its output, preserving steering. */
export function executionOrder(source: {
  order: readonly string[];
  item(id: string): Item | undefined;
  turnOf?(id: string): string | undefined;
  run?(id: string): Pick<Run, "state"> | undefined;
}): readonly string[] {
  const outputTurns = new Set<string>();
  for (const id of source.order) {
    const item = source.item(id);
    const turn = source.turnOf?.(id);
    if (turn && !(item?.type === "message" && item.role === "user")) outputTurns.add(turn);
  }
  const order: string[] = [];
  const pending = new Map<string, string[]>();
  const seen = new Set<string>();
  for (const id of source.order) {
    const item = source.item(id);
    const turn = source.turnOf?.(id);
    if (
      turn &&
      item?.type === "message" &&
      item.role === "user" &&
      !item.synthetic &&
      item.origin?.commandId &&
      (outputTurns.has(turn) || source.run?.(turn)?.state === "active") &&
      !seen.has(turn)
    ) {
      const inputs = pending.get(turn) ?? [];
      inputs.push(id);
      pending.set(turn, inputs);
      continue;
    }
    if (turn) {
      order.push(...(pending.get(turn) ?? []));
      pending.delete(turn);
      seen.add(turn);
    }
    order.push(id);
  }
  for (const inputs of pending.values()) order.push(...inputs);
  return order;
}
