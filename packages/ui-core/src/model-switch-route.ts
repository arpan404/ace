import { switchRoute, switchRoutePreservingSource, type SwitchRoute } from "@ace/core/switch-route";
import type { Thread } from "@ace/protocol";
import { choiceSelection, type ModelChoice } from "./models.ts";

export type { SwitchRoute };
type SwitchThread = Pick<Thread, "provider" | "backend" | "execution" | "live">;

const currentSide = (thread: SwitchThread) => ({
  provider: thread.execution?.provider ?? thread.provider,
  instanceId: thread.execution?.instanceId ?? thread.live?.account,
  backend: thread.backend,
});

/**
 * How picking `choice` in a thread's composer continues it: in the thread itself, in a new
 * thread carrying its context (a Cursor thread leaving Cursor or its account), or not at all.
 * The daemon refuses a `thread.switch` by the same rule, so the composer never sends one it
 * would refuse.
 */
export function threadSwitchRoute(thread: SwitchThread, choice: ModelChoice): SwitchRoute {
  return switchRoute(currentSide(thread), choiceSelection(choice));
}

/** Provider and account changes chosen with source preservation enabled start a new thread. */
export function threadForkSwitchRoute(thread: SwitchThread, choice: ModelChoice): SwitchRoute {
  return switchRoutePreservingSource(currentSide(thread), choiceSelection(choice));
}

/** What the model picker says beside a model this thread can't move to. */
export const switchUnsupportedNote = "Starts new threads only";

/** What a model or account switch says until it reaches the agent. */
export const switchNextTurnNote = "Applies at the agent's next turn";

/** What the model control says while a continuation waits for the person's next message. */
export const continuationNote = "Continues in a new thread with your next message";
