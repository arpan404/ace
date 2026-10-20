import { useClient, useInteraction, useInteractions } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import { requestIdentity } from "@ace/ui-core";
import { composerReply } from "../interactions/composer-reply.ts";
import { questionDrafts } from "../interactions/question-drafts.ts";
import type { Draft } from "./draft.ts";

const pendingQuestion = (interaction: Interaction) =>
  interaction.state === "pending" && interaction.request.kind === "question";

/** Only words: no files, mentions, references or other parts that an answer can't carry. */
const plainWords = (draft: Draft) =>
  !draft.files.local.length &&
  !draft.mentions.length &&
  !draft.threadRefs?.length &&
  (draft.input ?? []).every((part) => part.type === "text");

/**
 * The composer while an agent asks the person something: its placeholder reads "Reply…"
 * and a message of plain words sent to a question the agent waits on answers it
 * (`composerReply`) instead of going in as a message. Only the request the strip shows first
 * is answered so; a message with files or references goes as it would.
 */
export function useQuestionReply(threadId: string) {
  const client = useClient();
  const asking = useInteraction(threadId, useInteractions(threadId, pendingQuestion)?.[0] ?? "");
  // The request on the strip by default: the oldest one still open.
  const first = useInteraction(threadId, useInteractions(threadId)?.[0] ?? "");
  const placeholder = asking ? "Reply…" : undefined;
  const reply = async (draft: Draft): Promise<boolean> => {
    if (first?.request.kind !== "question" || !plainWords(draft)) return false;
    const resolution = composerReply(first, questionDrafts.get(first.id), draft.text);
    if (!resolution) return false;
    const { sendAnswer } = await import("../interactions/answer-sender.ts");
    return sendAnswer(
      client,
      (payload) => client.enqueue(payload),
      {
        interactionId: first.id,
        identity: requestIdentity(first),
        questions: first.request.questions,
      },
      resolution,
    );
  };
  return { placeholder, reply };
}
