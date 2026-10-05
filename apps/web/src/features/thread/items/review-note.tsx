import { useInteraction, useItem } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { reviewedInteraction } from "@ace/ui-core";
import { PermissionReviewNote } from "@/components/permission-review.tsx";

/**
 * A permission-review notice. One approval reads in one place (IR-2): when the step it reviewed
 * is in the transcript, that step's row carries the outcome and its detail the review, so the
 * notice stays out of the way. Otherwise (history paged out, a request without a step) it
 * reads as one quiet line whose verdict follows the request: "Approved by you" once answered.
 */
export function ReviewNote(props: { threadId: string; item: Extract<Item, { type: "notice" }> }) {
  const interaction = useInteraction(props.threadId, reviewedInteraction(props.item) ?? "");
  const step = useItem(props.threadId, interaction?.toolCallId ?? "");
  const review = interaction?.review;
  if (step) return null;
  if (!review) return <p className="text-ui text-muted-foreground">{props.item.text}</p>;
  return (
    <PermissionReviewNote
      review={review}
      interaction={interaction}
      waiting={interaction.state === "pending"}
    />
  );
}
