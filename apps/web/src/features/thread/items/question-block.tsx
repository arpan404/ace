import { Suspense } from "react";
import { DeferredQuestionRecord } from "../interactions/deferred-card.ts";

const QuestionRecord = DeferredQuestionRecord.Component;

/**
 * A question where the agent asked it (IR-1): one line saying it is being asked (the card to
 * answer it is on the composer), then the question with its answer. Never a user bubble, never
 * folded into a work log.
 */
export function QuestionBlock(props: { threadId: string; interactionId: string }) {
  return (
    <Suspense fallback={null}>
      <QuestionRecord threadId={props.threadId} interactionId={props.interactionId} />
    </Suspense>
  );
}
