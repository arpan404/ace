import type { ThreadReader } from "@ace/client";

/*
 * Which root turn an item belongs to. Kept apart from the diff code in `turns.ts`, so the
 * thread screen can number turns without loading the Changes tab's diffing.
 */

export type TurnReader = Pick<ThreadReader, "order" | "item" | "run" | "agent" | "thread">;

/**
 * The root agent's run an item's run belongs to: its own when the root ran it, else the root
 * run that spawned the subagent that ran it (following `spawnedBy`).
 */
export function rootRunOf(reader: TurnReader, runId: string | undefined, depth = 0) {
  const run = runId ? reader.run(runId) : undefined;
  if (!run || depth > 16) return undefined;
  if (run.agentId === reader.thread?.rootAgentId) return run;
  const spawn = reader.agent(run.agentId)?.spawnedBy;
  return rootRunOf(reader, spawn ? reader.item(spawn)?.runId : undefined, depth + 1);
}

/**
 * The root turn (its stable ordinal, ADR 0062) each item of `order` belongs to, or undefined
 * where it isn't known (the run was evicted, or nothing has started yet). A subagent's items
 * count toward the root turn that spawned it. A person's message belongs to the turn that
 * answers it: the next known turn after it, which is the running turn when it steered into one.
 * Pure over the reader; linear in `order`.
 */
export function itemTurnOrdinals(
  reader: TurnReader,
  order: readonly string[] = reader.order,
): (number | undefined)[] {
  const ordinals: (number | undefined)[] = order.map((id) => {
    const item = reader.item(id);
    if (!item || (item.type === "message" && item.role === "user")) return undefined;
    return rootRunOf(reader, item.runId)?.ordinal;
  });
  let next: number | undefined;
  for (let index = order.length - 1; index >= 0; index--) {
    const known = ordinals[index];
    if (known !== undefined) next = known;
    else {
      const item = reader.item(order[index] ?? "");
      if (item?.type === "message" && item.role === "user") ordinals[index] = next;
    }
  }
  return ordinals;
}
