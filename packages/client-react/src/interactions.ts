import type { ThreadKey, ThreadReader } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import { useCallback } from "react";
import { arrayEqual } from "./selection.ts";
import { useThread } from "./thread.ts";

const membership: readonly ThreadKey[] = ["interactions"];
const pending = (interaction: Interaction) => interaction.state === "pending";

/**
 * Ids of a thread's interactions that pass `filter` (pending by default). The store announces
 * `interactions` whenever one opens or closes, so one key follows the list at any size.
 */
export function useInteractions(
  threadId: string | undefined,
  filter: (interaction: Interaction) => boolean = pending,
): readonly string[] | undefined {
  const selector = useCallback(
    (reader: ThreadReader) =>
      reader.interactionIds().filter((id) => {
        const interaction = reader.interaction(id);
        return !!interaction && filter(interaction);
      }),
    [filter],
  );
  return useThread(threadId, membership, selector, arrayEqual);
}
export function useInteraction(threadId: string | undefined, interactionId: string) {
  const selector = useCallback(
    (reader: ThreadReader) => reader.interaction(interactionId),
    [interactionId],
  );
  return useThread(threadId, [`interaction:${interactionId}`], selector);
}
