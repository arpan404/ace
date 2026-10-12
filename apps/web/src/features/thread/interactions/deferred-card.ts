import { deferredComponent } from "@/lib/deferred-component.tsx";

/**
 * The card for a pending approval, question or plan, loaded after first paint.
 */
export const DeferredInteractionCard = deferredComponent(() =>
  import("./interaction-card.tsx").then((module) => module.InteractionCard),
);

/** A question's line in the transcript, where the agent asked it (answered on the composer). */
export const DeferredQuestionRecord = deferredComponent(() =>
  import("./question-record.tsx").then((module) => module.QuestionRecord),
);

/** Approval markers and decisions in the transcript; buttons stay on the composer. */
export const DeferredApprovalRecord = deferredComponent(() =>
  import("./approval-record.tsx").then((module) => module.ApprovalRecord),
);
