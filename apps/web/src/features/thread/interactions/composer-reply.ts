import type { Interaction, InteractionResolution } from "@ace/protocol";
import { answerOf, isAnswered, type QuestionDraft } from "./question-draft.ts";

/**
 * Whether a message sent from the composer answers the question on the strip instead of going
 * to the agent, and with what. Only a question the agent waits on (blocking, still pending) is
 * answered so, and only when the words can be its answer: they answer the question on screen
 * (in place of a single pick, beside several) and every other question not answered yet, while
 * the picks made on the card stay. When the question on screen, or one still unanswered, takes
 * no free text, the message stays a message; so does one with no words. Pure.
 */
export function composerReply(
  interaction: Pick<Interaction, "state" | "blocking" | "request"> | undefined,
  draft: QuestionDraft,
  text: string,
): InteractionResolution | undefined {
  const words = text.trim();
  if (!words || !interaction?.blocking || interaction.state !== "pending") return undefined;
  if (interaction.request.kind !== "question") return undefined;
  const { questions } = interaction.request;
  const current = questions[Math.min(Math.max(draft.at, 0), questions.length - 1)];
  if (!current?.allowOther) return undefined;
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const given = answerOf(question, draft);
    if (question === current) {
      const picks = given.filter((id) => question.options.some((option) => option.id === id));
      answers[question.id] = question.multiSelect ? [...picks, words] : [words];
    } else if (isAnswered(question, draft)) answers[question.id] = given;
    else if (question.allowOther) answers[question.id] = [words];
    else return undefined;
  }
  return { kind: "question", answers };
}
