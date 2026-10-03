import type { ThreadKey, ThreadReader } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import { useCallback, useMemo } from "react";
import { arrayEqual } from "./selection.ts";
import { useThreadStore } from "./leases.ts";
import { useStoreSelect, useThread } from "./thread.ts";

const readIds = (reader: ThreadReader) => reader.interactionIds();
const pending = (interaction: Interaction) => interaction.state === "pending";

/**
 * Ids of a thread's interactions that pass `filter` (pending by default). Watches membership
 * and each interaction's own key, so a resolution elsewhere removes it from the list.
 */
export function useInteractions(
  threadId: string | undefined,
  filter: (interaction: Interaction) => boolean = pending,
): readonly string[] | undefined {
  const store = useThreadStore(threadId);
  const ids = useStoreSelect(store, ["interactions"], readIds, arrayEqual);
  const keys = useMemo<ThreadKey[]>(
    () => ["interactions", ...(ids ?? []).map((id): ThreadKey => `interaction:${id}`)],
    [ids],
  );
  const selector = useCallback(
    (reader: ThreadReader) =>
      reader.interactionIds().filter((id) => {
        const interaction = reader.interaction(id);
        return !!interaction && filter(interaction);
      }),
    [filter],
  );
  return useStoreSelect(store, keys, selector, arrayEqual);
}
export function useInteraction(threadId: string | undefined, interactionId: string) {
  const selector = useCallback(
    (reader: ThreadReader) => reader.interaction(interactionId),
    [interactionId],
  );
  return useThread(threadId, [`interaction:${interactionId}`], selector);
}
