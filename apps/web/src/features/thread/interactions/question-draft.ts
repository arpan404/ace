import type { Question } from "@ace/protocol";

/*
 * What the person has given a question card so far, and what it answers. Pure: the form and
 * the composer both read a draft through these, so a reply typed in the composer keeps the
 * picks made on the card.
 */

/** The pick that stands for the words typed in the free answer. */
export const otherAnswer = "__other__";

export interface QuestionDraft {
  /** Question id → the option ids picked, `otherAnswer` for the free answer. */
  picked: Readonly<Record<string, readonly string[]>>;
  /** Question id → the words typed in its free answer. */
  texts: Readonly<Record<string, string>>;
  /** The question on screen. */
  at: number;
}

export const emptyDraft: QuestionDraft = { picked: {}, texts: {}, at: 0 };

/** A question's answer from the draft: its picked options, the free answer as its words. */
export function answerOf(question: Question, draft: QuestionDraft): string[] {
  return (draft.picked[question.id] ?? []).flatMap((id) => {
    if (id !== otherAnswer) return [id];
    const words = draft.texts[question.id]?.trim();
    return words ? [words] : [];
  });
}

/** Whether the draft answers `question`: something picked, and words where the free answer is. */
export function isAnswered(question: Question | undefined, draft: QuestionDraft): boolean {
  const choice = (question && draft.picked[question.id]) ?? [];
  if (!question || choice.length === 0) return false;
  return !choice.includes(otherAnswer) || !!draft.texts[question.id]?.trim();
}

/** Every question's answer, as the card's Continue sends them on the last question. */
export function draftAnswers(
  questions: readonly Question[],
  draft: QuestionDraft,
): Record<string, string[]> {
  return Object.fromEntries(questions.map((question) => [question.id, answerOf(question, draft)]));
}
