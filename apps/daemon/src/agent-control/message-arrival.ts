import type { MessageArrival, ThreadStatus } from "@ace/protocol";

export interface ArrivalFacts {
  status: ThreadStatus["state"];
  /** The thread's queue is held after this message was admitted. */
  held: boolean;
  /** The thread's provider can steer a running turn. */
  steers: boolean;
  delivery: "queue" | "steer";
  /** Messages in the thread's queue besides this one. */
  ahead: number;
}

const midTurn = new Set<ThreadStatus["state"]>(["working", "needs_you", "unresponsive"]);

/** Picks `MessageArrival` from what the thread is doing when ace accepts the message. */
export function messageArrival(facts: ArrivalFacts): MessageArrival {
  if (facts.held || facts.status === "limited") return "held";
  if (facts.delivery === "steer" && facts.steers && midTurn.has(facts.status)) return "steering";
  if (midTurn.has(facts.status) || facts.ahead > 0) return "queued";
  return "starting";
}
