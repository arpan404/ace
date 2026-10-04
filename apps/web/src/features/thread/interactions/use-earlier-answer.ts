import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { questionTitle } from "@ace/ui-core";
import { useCallback } from "react";

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
