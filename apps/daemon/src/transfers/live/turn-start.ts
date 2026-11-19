import type { InputFate } from "../../engine/input-fate.ts";

/*
 * Whether the moved thread's first turn started on the target (ADR 0191), read on the one
 * continue message itself, by its command id: never on the thread's status, which a turn the
 * person starts there would also change. Pure.
 */

export type TurnStart = { kind: "running" } | { kind: "wait" } | { kind: "failed" };

/** What became of the continue message, and whether the queue holds it after a failure. */
export interface ContinueFacts {
  fate: InputFate["state"];
  /** The queue is paused on a failure (`not_sent`, `model_unavailable`), the message in it. */
  held: boolean;
}

export function turnStart({ fate, held }: ContinueFacts): TurnStart {
  switch (fate) {
    // It reached its run. Uncertain: it may have, and the person decides as on any thread.
    case "delivered":
    case "uncertain":
      return { kind: "running" };
    // The person sent it again or took it out: the thread is theirs to carry on from here.
    case "replaced":
    case "removed":
      return { kind: "running" };
    case "failed":
      return { kind: "failed" };
    case "waiting":
      return held ? { kind: "failed" } : { kind: "wait" };
    case "sending":
    case "unknown":
      return { kind: "wait" };
  }
}
