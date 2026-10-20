import type { FollowUpBehavior, ThreadStatus } from "@ace/protocol";
import { threadIsRunning } from "./live-status.ts";

/** The agent is mid-turn or held up: a new message follows up rather than starting a turn. */
export function isBusy(status: ThreadStatus | undefined): boolean {
  return threadIsRunning(status) || status?.state === "limited";
}

/**
 * How a message sent now is delivered. An idle thread leaves it unset, so the daemon starts a
 * turn. While the agent works it is said outright: the person's follow-up setting where the
 * provider can take input mid-turn, else queue (also while capabilities are unknown, SY-14).
 * `opposite` (the modified send) picks the other one, which only a steering provider offers.
 */
/**
 * How a message sent now goes in while the root agent only waits on its subagents: straight in,
 * since the model itself isn't busy. A steer goes into the waiting turn, or starts the next one
 * when the root's turn is over (a provider that can't steer queues it, which also goes at once
 * with no turn running). Only a waiting turn on a provider that can't steer holds it to the turn's
 * end. The modified send queues it.
 */
export function waitingDelivery(input: {
  canSteer: boolean;
  /** The root's own turn has ended while its subagents carry on. */
  turnOver: boolean;
  opposite: boolean;
}): FollowUpBehavior {
  if (input.opposite) return "queue";
  return input.canSteer || input.turnOver ? "steer" : "queue";
}

export function followUpDelivery(input: {
  status: ThreadStatus | undefined;
  canSteer: boolean;
  setting: FollowUpBehavior | undefined;
  opposite: boolean;
}): FollowUpBehavior | undefined {
  if (!isBusy(input.status)) return undefined;
  const followUp = input.canSteer ? (input.setting ?? "queue") : "queue";
  if (!input.opposite || !input.canSteer) return followUp;
  return followUp === "steer" ? "queue" : "steer";
}
