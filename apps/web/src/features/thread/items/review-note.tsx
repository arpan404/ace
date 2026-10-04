import { useInteraction } from "@ace/client-react";
import type { Item } from "@ace/protocol";
import { reviewedInteraction } from "@ace/ui-core";
import { PermissionReviewNote } from "@/components/permission-review.tsx";

/**
 * A permission-review notice: ace's decision, its reason and the exact target it judged, read
 * from the interaction the daemon reviewed. Without it (history paged out) the notice's own
 * text stands in.
 */
export function ReviewNote(props: { threadId: string; item: Extract<Item, { type: "notice" }> }) {
  const interaction = useInteraction(props.threadId, reviewedInteraction(props.item) ?? "");
  const review = interaction?.review;
  if (!review) return <p className="text-ui text-muted-foreground">{props.item.text}</p>;
  return <PermissionReviewNote review={review} waiting={interaction.state === "pending"} />;
}
