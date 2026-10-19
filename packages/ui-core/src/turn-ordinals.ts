import type { ThreadReader } from "@ace/client";
import { runTurn, startsTurn } from "@ace/projection";

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
 * where it isn't known (the run was evicted, or nothing has started yet). A turn is an ask and
 * every root run after it until the next ask (`Run.turn`), so a run the agent started by itself
 * shares the ask's turn. A subagent's items count toward the root turn that spawned it. A
 * message that asks (`startsTurn`) belongs to the turn that answers it: the next known turn
 * after it, which is the running turn when it steered into one. A user-role message that
 * carries the turn on (an agent's result, a question's answer) stays in the turn before it.
 * Pure over the reader; linear in `order`.
 */
export function itemTurnOrdinals(
  reader: TurnReader,
  order: readonly string[] = reader.order,
): (number | undefined)[] {
  const fromRuns: (number | undefined)[] = [];
  const kinds: ("ask" | "carry" | "other")[] = [];
  for (const id of order) {
    const item = reader.item(id);
    if (item?.type === "message" && item.role === "user") {
      fromRuns.push(undefined);
      kinds.push(startsTurn(item) ? "ask" : "carry");
      continue;
    }
    const run = item ? rootRunOf(reader, item.runId) : undefined;
    fromRuns.push(run ? runTurn(run) : undefined);
    kinds.push("other");
  }
  const ordinals = [...fromRuns];
  let next: number | undefined;
  for (let index = order.length - 1; index >= 0; index--) {
    const known = fromRuns[index];
    if (known !== undefined) next = known;
    else if (kinds[index] !== "other") ordinals[index] = next;
  }
  let previous: number | undefined;
  for (let index = 0; index < order.length; index++) {
    const known = fromRuns[index];
    if (known !== undefined) previous = known;
    else if (kinds[index] === "carry" && previous !== undefined) ordinals[index] = previous;
  }
  return ordinals;
}
