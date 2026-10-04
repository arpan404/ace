import type { ThreadReader } from "@ace/client";
import { useInteraction, useThread } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { useCallback } from "react";

/**
 * The interaction a tool call asked for (its approval), looked up by `toolCallId`. Membership
 * changes only when one opens or closes, so the list key covers the lookup.
 */
export function useItemInteraction(threadId: string, itemId: string): Interaction | undefined {
  const find = useCallback(
    (reader: ThreadReader) => {
      if (!itemId) return undefined;
      let found: string | undefined;
      for (const id of reader.interactionIds()) {
        const interaction = reader.interaction(id);
        // The newest wins: a request offered again replaces the one before it.
        if (interaction?.toolCallId === itemId) found = id;
      }
      return found;
    },
    [itemId],
  );
  const id = useThread(threadId, ["interactions"], find);
  return useInteraction(threadId, id ?? "");
}
