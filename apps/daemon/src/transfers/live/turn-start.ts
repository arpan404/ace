import { cancelledByStop, type InputFate } from "../../engine/input-fate.ts";

/*
 * Whether the moved thread's first turn started on the target (ADR 0191), read on the one
 * continue message itself, by its command id: never on the thread's status, which a turn the
 * person starts there would also change. Pure.
 */

export type TurnStart =
  /** A run took the continue message itself. */
  | { kind: "running" }
  | { kind: "wait" }
  /** It may have reached its run or not; the person decides, so the watch keeps reading. */
  | { kind: "uncertain" }
  /** Held unsent after a failure. */
  | { kind: "failed" }
  /** The person stopped the thread, took the message out or sent it again: it won't start. */
  | { kind: "person"; reason: string };

/** What became of the continue message, and whether the queue holds it. */
export interface ContinueFacts {
  fate: InputFate;
  /** The queue is paused on a failure (`not_sent`, `model_unavailable`), the message in it. */
  held: boolean;
  /** The queue is paused by the person's Stop, the message in it. */
  stopped?: boolean;
}

export function turnStart({ fate, held, stopped }: ContinueFacts): TurnStart {
  switch (fate.state) {
    // Taken from the queue and written to the transcript, but no run has it until the provider's
    // turn starts on it: an open that fails then puts it back, held.
    case "delivered":
      return fate.runId === undefined ? { kind: "wait" } : { kind: "running" };
    case "uncertain":
      return { kind: "uncertain" };
    case "replaced":
      return { kind: "person", reason: "the person sent the message again" };
    case "removed":
      return { kind: "person", reason: "the person took the message out" };
    // The person's Stop cancelled it, written or not, before any run took it.
    case "failed":
      return fate.error === cancelledByStop
        ? { kind: "person", reason: "the person stopped it" }
        : { kind: "failed" };
    case "waiting":
      if (held) return { kind: "failed" };
      return stopped ? { kind: "person", reason: "the person stopped it" } : { kind: "wait" };
    case "sending":
    case "unknown":
      return { kind: "wait" };
  }
}
