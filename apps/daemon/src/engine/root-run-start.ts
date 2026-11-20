import type { RunTrigger } from "@ace/protocol";

/** The engine input the session was handed and has not acknowledged yet. */
export interface AwaitingInput {
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
 * The root run a provider started with `trigger`, while `awaiting` waits for acknowledgement:
 * the trigger it records, and whether its start takes that input. A run started for given input
 * while ace's own message waits is that message's run, so it carries the message's trigger
 * (a parcel notice's `background_completion`, say) and takes it, whatever the trigger is. Pure.
 */
export function rootRunStart(
  trigger: RunTrigger,
  awaiting: AwaitingInput | undefined,
): { trigger: RunTrigger; takesInput: boolean } {
  if (
    awaiting?.trigger &&
    (awaiting.kind === "thread.create" || awaiting.kind === "thread.send") &&
    GIVEN_INPUT.has(trigger)
  )
    return { trigger: awaiting.trigger, takesInput: true };
  return { trigger, takesInput: TAKES_INPUT.has(trigger) };
}
