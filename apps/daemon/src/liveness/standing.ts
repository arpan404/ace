import { contact, type Lease } from "./lease.ts";
import { nextStop, type StopDecision, type StopPlan, type StopProgress } from "./stop.ts";

/*
 * Where one tracked item stands, from its lease and any stop in progress: the single rule every
 * source of "working", "waiting" or "running" goes through (ADR 0052, "Stop and proof of life").
 * Pure.
 */

export interface ItemFacts<Action extends string> {
  /** The other side reported its own end (done, failed or cancelled). Final. */
  readonly ended: boolean;
  readonly lease: Lease;
  /** A stop in progress, under `plan`. */
  readonly stop?: { readonly plan: StopPlan<Action>; readonly progress: StopProgress } | undefined;
  /** Ace already called it stopped without confirmation; a later report never revives it. */
  readonly stoppedUnconfirmed?: boolean | undefined;
}

export type Standing<Action extends string> =
  | { readonly kind: "live" }
  /** Stopping, within its bound: `next` says what the stop does now. */
  | { readonly kind: "stopping"; readonly next: Exclude<StopDecision<Action>, { kind: "give_up" }> }
  /** Every stop attempt went out and none was confirmed: stopped, saying so. */
  | { readonly kind: "stopped_unconfirmed" }
  | { readonly kind: "lost"; readonly since: number }
  | { readonly kind: "ended" };

export function standing<Action extends string>(
  facts: ItemFacts<Action>,
  now: number,
): Standing<Action> {
  if (facts.ended) return { kind: "ended" };
  if (facts.stoppedUnconfirmed) return { kind: "stopped_unconfirmed" };
  if (facts.stop) {
    const next = nextStop(facts.stop.plan, facts.stop.progress, now);
    // A stop ends by itself: it gives up on its own bound, whatever the lease says.
    if (next.kind === "give_up") return { kind: "stopped_unconfirmed" };
    return { kind: "stopping", next };
  }
  const reach = contact(facts.lease, now);
  return reach.kind === "lost" ? { kind: "lost", since: reach.since } : { kind: "live" };
}

/**
 * Whether the item keeps its parent from reading done. Live work and a stop still inside its
 * bound do; an item that ended, was stopped or lost contact does not.
 */
export function holdsParent<Action extends string>(at: Standing<Action>): boolean {
  return at.kind === "live" || at.kind === "stopping";
}
