import { Suspense } from "react";
import { DeferredInteractionCard } from "../interactions/deferred-card.ts";

const InteractionCard = DeferredInteractionCard.Component;

/**
 * A question where the agent asked it (IR-1): the card to answer while it is open, then the
 * question with its answer, read-only. Never a user bubble, never folded into a work log.
 */
export function QuestionBlock(props: { threadId: string; interactionId: string }) {
  return (
    <Suspense fallback={null}>
      <InteractionCard threadId={props.threadId} interactionId={props.interactionId} />
    </Suspense>
  );
}
