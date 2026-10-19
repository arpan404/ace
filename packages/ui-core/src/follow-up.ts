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
