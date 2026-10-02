import type { Fact, State } from "./schema.ts";

const DATA_LIMIT = 65_536;
const CONTROL_LIMIT = DATA_LIMIT + 1024;

/** Cancellation and fenced terminal cleanup stay idempotent even after the reserve is full. */
export function retainReceipt(state: State, fact: Fact, count: number): boolean {
  if (count < DATA_LIMIT) return true;
  const cleanup =
    ["cancelling", "cancelled"].includes(state.phase) &&
    fact.type === "status" &&
    ["done", "failed"].includes(fact.status);
  if (fact.type === "cancel" || cleanup) return count < CONTROL_LIMIT;
  if (!["approve", "pause", "resume"].includes(fact.type)) throw new Error("input_backpressure");
  if (count >= CONTROL_LIMIT) throw new Error("control_backpressure");
  return true;
}
