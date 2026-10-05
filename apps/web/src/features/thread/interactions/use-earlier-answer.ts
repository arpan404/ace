import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { requestIdentity } from "@ace/ui-core";
import { useCallback } from "react";

/**
 * The answer an earlier copy of this same native request got (A1/A3): after a restart a
 * provider can replay a request it already had answered, under a new interaction id. Copies
 * share their native item and every word of the request (`requestIdentity`); the same wording
 * asked again later, or a different request, never matches. Until the backend dedupes replays,
 * the copy reads as answered with the first copy's answer.
 */
export function useEarlierAnswer(threadId: string, interaction: Interaction | undefined) {
  const id = interaction?.id ?? "";
  const pending = interaction?.state === "pending";
  const find = useCallback(
    (reader: ThreadReader) => {
      const current = reader.interaction(id);
      if (!pending || !current) return undefined;
      const mine = requestIdentity(current);
      if (!mine) return undefined;
      for (const other of reader.interactionIds()) {
        if (other === id) continue;
        const earlier = reader.interaction(other);
        if (
          earlier?.resolution?.kind === current.request.kind &&
          earlier.createdAt <= current.createdAt &&
          requestIdentity(earlier) === mine
        )
          return earlier;
      }
      return undefined;
    },
    [id, pending],
  );
  return useThread(threadId, ["interactions"], find);
}
