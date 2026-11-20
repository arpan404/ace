import type { RunTrigger } from "@ace/protocol";

/** The input ace handed the session that no run has taken yet (`pending.handedOver`). */
export interface HandedOverInput {
  kind: string;
  trigger?: RunTrigger | undefined;
}

/** What a provider calls a run it started for input it was given, not for its own reasons. */
const GIVEN_INPUT: ReadonlySet<RunTrigger> = new Set(["user", "queue", "unknown"]);

/**
 * Runs whose start takes the input the engine handed the session: given input, ace's own labels
 * for it, and ace's continuations. A provider's own wake (a native child's result, a finished
 * shell, a goal it pursues) never does: whatever ace handed it is still waiting.
 */
const TAKES_INPUT: ReadonlySet<RunTrigger> = new Set([
  ...GIVEN_INPUT,
  "spawn",
  "parent_agent",
  "schedule",
  "restart",
  "limit_resume",
]);

/**
 * The root run a provider started with `trigger`, while `handedOver` is the input ace gave it
 * that no run has taken: the trigger it records, and whether its start takes that input. A run
 * started for given input is that input's run, so it carries the input's own trigger (a parcel
 * notice's `background_completion`, say) and takes it, whatever the trigger is. Only input that
 * was handed over is ever named here: one still being prepared is no run's yet. Pure.
 */
export function rootRunStart(
  trigger: RunTrigger,
  handedOver: HandedOverInput | undefined,
): { trigger: RunTrigger; takesInput: boolean } {
  if (
    handedOver?.trigger &&
    (handedOver.kind === "thread.create" || handedOver.kind === "thread.send") &&
    GIVEN_INPUT.has(trigger)
  )
    return { trigger: handedOver.trigger, takesInput: true };
  return { trigger, takesInput: TAKES_INPUT.has(trigger) };
}
