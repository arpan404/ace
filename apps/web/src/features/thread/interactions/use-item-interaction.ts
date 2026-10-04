import type { ThreadReader } from "@ace/client";
import { useInteraction, useThread } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { questionTitle } from "@ace/ui-core";
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

/** What makes two requests the same request: its kind and what it asks. */
function signature(interaction: Interaction): string | undefined {
  const request = interaction.request;
  if (request.kind === "question")
    return `q:${questionTitle(request.questions)}:${request.questions.map((question) => question.options.map((option) => option.label).join("|")).join("/")}`;
  if (request.kind === "approval")
    return interaction.toolCallId
      ? `a:${interaction.toolCallId}`
      : `a:${request.title}:${request.target?.command ?? ""}`;
  return undefined;
}

/**
 * The answer an earlier copy of this request already got (A1/A3): after a restart the daemon
 * can offer a request again under a new id. Until the backend dedupes them, the copy reads as
 * answered with the first copy's answer.
 */
export function useEarlierAnswer(threadId: string, interaction: Interaction | undefined) {
  const id = interaction?.id ?? "";
  const pending = interaction?.state === "pending";
  const find = useCallback(
    (reader: ThreadReader) => {
      const current = reader.interaction(id);
      if (!pending || !current) return undefined;
      const mine = signature(current);
      if (!mine) return undefined;
      for (const other of reader.interactionIds()) {
        if (other === id) continue;
        const earlier = reader.interaction(other);
        if (
          earlier?.resolution &&
          earlier.createdAt <= current.createdAt &&
          signature(earlier) === mine
        )
          return earlier;
      }
      return undefined;
    },
    [id, pending],
  );
  return useThread(threadId, ["interactions"], find);
}
