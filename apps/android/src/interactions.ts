import type { Interaction, Question } from "@ace/protocol";
import { answerOf, draftAnswers, isAnswered, otherAnswer, type QuestionDraft } from "@ace/ui-core";

export const questionLimit = 8;
export const optionLimit = 32;

export type InteractionAnswerState = "pending" | "resolved" | "cancelled" | "expired";

/** Whether a card may send a resolution now. Stale, answered, view-only or in-flight sends nothing. */
export function canResolveInteraction(
  state: InteractionAnswerState | string,
  inFlight: boolean,
  canAct: boolean,
): boolean {
  return state === "pending" && !inFlight && canAct;
}

/** Clamp a pager to the visible window. Pure. */
export function currentQuestionIndex(at: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(at, 0), count - 1);
}

/** Whether the bridge caps this question set for a phone card (answer on a larger screen). */
export function isUnanswerable(questions: readonly Question[]): boolean {
  return (
    questions.length > questionLimit ||
    questions.some((question) => question.options.length > optionLimit)
  );
}

/** The questions a phone card shows (bounded, exact ids preserved). */
export function visibleQuestions(questions: readonly Question[]): Question[] {
  const shown: Question[] = [];
  for (const question of questions.slice(0, questionLimit)) {
    shown.push({ ...question, options: question.options.slice(0, optionLimit) });
  }
  return shown;
}

export function emptyQuestionDraft(): QuestionDraft {
  return { picked: {}, texts: {}, at: 0 };
}

/** Toggle one option: multi-select adds/removes, single-select replaces and clears free text. */
export function togglePick(
  draft: QuestionDraft,
  question: Pick<Question, "id" | "multiSelect">,
  optionId: string,
): QuestionDraft {
  const current = draft.picked[question.id] ?? [];
  if (question.multiSelect) {
    const next = current.includes(optionId)
      ? current.filter((id) => id !== optionId)
      : [...current, optionId];
    return { ...draft, picked: { ...draft.picked, [question.id]: next } };
  }
  return {
    ...draft,
    picked: { ...draft.picked, [question.id]: [optionId] },
    texts: { ...draft.texts, [question.id]: "" },
  };
}

/** Type free text for a question that allows its own words. */
export function setOtherText(
  draft: QuestionDraft,
  question: Pick<Question, "id" | "multiSelect">,
  text: string,
): QuestionDraft {
  const picked = draft.picked[question.id] ?? [];
  if (question.multiSelect) {
    const hasOther = picked.includes(otherAnswer);
    const next = text.trim()
      ? hasOther
        ? picked
        : [...picked, otherAnswer]
      : picked.filter((id) => id !== otherAnswer);
    return {
      ...draft,
      picked: { ...draft.picked, [question.id]: next },
      texts: { ...draft.texts, [question.id]: text },
    };
  }
  const next = text.trim() ? [] : picked.filter((id) => id !== otherAnswer);
  // Single-select free text replaces a picked option; keep the marker so validation sees words.
  const withMarker = text.trim() ? [otherAnswer] : next;
  return {
    ...draft,
    picked: { ...draft.picked, [question.id]: withMarker },
    texts: { ...draft.texts, [question.id]: text },
  };
}

/** Whether the draft answers one question (picks present, words where the free answer is). */
export function isQuestionAnswered(question: Question, draft: QuestionDraft): boolean {
  return isAnswered(question, draft);
}

/** This page may advance: the visible question has an answer. */
export function canContinue(question: Question | undefined, draft: QuestionDraft): boolean {
  return isAnswered(question, draft);
}

/**
 * Every question's answer, or undefined while any question is unanswered.
 * Free text rides as its words; picks keep exact option ids.
 */
export function completeAnswers(
  questions: readonly Question[],
  draft: QuestionDraft,
): Record<string, string[]> | undefined {
  for (const question of questions) {
    if (!isAnswered(question, draft)) return undefined;
  }
  return draftAnswers(questions, draft);
}

/** One question's answer from the draft (exact ids, free text as words). */
export function answerFor(question: Question, draft: QuestionDraft): string[] {
  return answerOf(question, draft);
}

/** The canonical question resolution the daemon validates; first answer wins there. */
export function questionResolution(
  questions: readonly Question[],
  draft: QuestionDraft,
): { kind: "question"; answers: Record<string, string[]> } | undefined {
  const answers = completeAnswers(questions, draft);
  return answers ? { kind: "question", answers } : undefined;
}

export function dismissedResolution(): {
  kind: "question";
  answers: Record<string, string[]>;
  dismissed: true;
} {
  return { kind: "question", answers: {}, dismissed: true };
}

export function approvalResolution(optionId: string): { kind: "approval"; optionId: string } {
  return { kind: "approval", optionId };
}

export function isPendingInteraction(interaction: Pick<Interaction, "state">): boolean {
  return interaction.state === "pending";
}
