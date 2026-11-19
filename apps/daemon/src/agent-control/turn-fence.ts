import type { RunAt } from "../engine/turn-origin.ts";

/*
 * The delegation fence a Stop sets on a thread's turn (ADR 0191): when a delegation call lifts
 * it. Pure.
 */

export interface TurnFenceFacts {
  /** The run the Stop ended ("" when none ran). */
  fenced: string;
  /** Delegation request ids already on their way when the Stop came. */
  inFlight: readonly string[];
  /** The thread's turn running now. */
  root?: RunAt | undefined;
  /** The run the calling agent is in itself. */
  origin?: RunAt | undefined;
  requestId: string;
}

/**
 * Only a call made from a turn that began after the Stop lifts the fence: a newer root turn is
 * running, the caller's own run is that turn or started within it, and the call isn't one the
 * stopped turn already had on its way. Every other call is the stopped turn's and is refused.
 */
export function turnFenceLifts(facts: TurnFenceFacts): boolean {
  const { root, origin } = facts;
  if (!root || root.id === facts.fenced || !origin) return false;
  // A run started no later than the new turn is the stopped turn's, a tie included.
  if (origin.id !== root.id && origin.startedAt <= root.startedAt) return false;
  return !facts.inFlight.includes(facts.requestId);
}
