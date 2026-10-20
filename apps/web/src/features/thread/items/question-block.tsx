import { useInteraction } from "@ace/client-react";
import { Suspense } from "react";
import { DeferredQuestionRecord, DeferredApprovalRecord } from "../interactions/deferred-card.ts";

const QuestionRecord = DeferredQuestionRecord.Component;

/**
 * A request where the agent asked it (IR-1). A question waiting on the person is one line saying
 * it is being asked (its card is on the composer), never folded; once answered its step reads in
 * the turn's work log instead. Never a user bubble.
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
