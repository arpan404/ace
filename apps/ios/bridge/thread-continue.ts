import type { ThreadReader } from "@ace/client";
import type { CommandPayload, MessageContext, ThreadId } from "@ace/protocol";
import {
  choiceSelection,
  continuationAttachmentProblem,
  continuationPlan,
  forkBudgetBytes,
  type ModelChoice,
} from "@ace/ui-core";

/*
 * A thread continued in a new one (the switch route `new_thread`): the person's next message is
 * the first of a fork from this thread's newest finished turn, on the model they picked, with
 * this thread's history as its context and the message's files, by the shared rules
 * (`continuationPlan`, `continuationAttachmentProblem`). This thread stays as it is.
 */

export type Continuation = { payload: CommandPayload } | { refused: string };

export function continuationPayload(request: {
  reader: ThreadReader;
  threadId: ThreadId;
  choice: ModelChoice;
  text: string;
  /** The message's files, and the new thread's model's input modalities from the catalog. */
  files: readonly { name: string; mimeType?: string | undefined }[];
  modalities: readonly string[] | undefined;
  context: MessageContext | undefined;
}): Continuation {
  const plan = continuationPlan(request.reader, request.text);
  if (!plan.ok) return { refused: plan.message };
  const problem = continuationAttachmentProblem(request.files, request.choice, request.modalities);
  if (problem) return { refused: problem };
  const title = request.reader.thread?.title;
  return {
    payload: {
      type: "thread.fork",
      threadId: request.threadId,
      point: plan.point,
      input: plan.input,
      budgetBytes: forkBudgetBytes,
      selection: { ...choiceSelection(request.choice), options: {} },
      ...(title ? { title } : {}),
      ...(request.context ? { context: request.context } : {}),
    },
  };
}
