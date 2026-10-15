import { switchRoute, type SwitchRoute } from "@ace/core/switch-route";
import type { Thread } from "@ace/protocol";
import { choiceSelection, type ModelChoice } from "./models.ts";

export type { SwitchRoute };

/**
 * How picking `choice` in a thread's composer continues it: in the thread itself, in a new
 * thread carrying its context (a Cursor thread leaving Cursor or its account), or not at all.
 * The daemon refuses a `thread.switch` by the same rule, so the composer never sends one it
 * would refuse.
 */
export function threadSwitchRoute(
  thread: Pick<Thread, "provider" | "backend" | "execution" | "live">,
  choice: ModelChoice,
): SwitchRoute {
  return switchRoute(
    {
      provider: thread.execution?.provider ?? thread.provider,
      instanceId: thread.execution?.instanceId ?? thread.live?.account,
      backend: thread.backend,
    },
    choiceSelection(choice),
  );
}

/** What the model picker says beside a model this thread can't move to. */
export const switchUnsupportedNote = "Starts new threads only";
