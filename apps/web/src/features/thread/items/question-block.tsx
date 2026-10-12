import { useInteraction } from "@ace/client-react";
import { Suspense } from "react";
import { DeferredQuestionRecord, DeferredApprovalRecord } from "../interactions/deferred-card.ts";

const QuestionRecord = DeferredQuestionRecord.Component;

/**
 * A question where the agent asked it (IR-1): one line saying it is being asked (the card to
 * answer it is on the composer), then the question with its answer. Never a user bubble, never
 * folded into a work log.
 */
export function QuestionBlock(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  return (
    <Suspense fallback={null}>
      {interaction?.request.kind === "approval" ? (
        <DeferredApprovalRecord.Component
          threadId={props.threadId}
          interactionId={props.interactionId}
        />
      ) : (
        <QuestionRecord threadId={props.threadId} interactionId={props.interactionId} />
      )}
    </Suspense>
  );
}
