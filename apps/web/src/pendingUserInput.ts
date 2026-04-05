import type { UserInputQuestion } from "@t3tools/contracts";

export type PendingUserInputResolvedAnswer = string | ReadonlyArray<string>;

export interface PendingUserInputDraftAnswer {
  selectedOptionLabel?: string;
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabel: string | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: PendingUserInputResolvedAnswer | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDraftAnswerList(values: ReadonlyArray<string> | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const answer = normalizeDraftAnswer(value);
    if (!answer || seen.has(answer)) {
      continue;
    }
    seen.add(answer);
    normalized.push(answer);
  }
  return normalized;
}

function hasResolvedPendingUserInputAnswer(answer: PendingUserInputResolvedAnswer | null): boolean {
  return Array.isArray(answer) ? answer.length > 0 : typeof answer === "string";
}

export function resolvePendingUserInputAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  question?: UserInputQuestion,
): PendingUserInputResolvedAnswer | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabel = normalizeDraftAnswer(draft?.selectedOptionLabel);
  const selectedOptionLabels = normalizeDraftAnswerList([
    ...(draft?.selectedOptionLabels ?? []),
    ...(selectedOptionLabel ? [selectedOptionLabel] : []),
  ]);

  if (question?.multiSelect === true || (selectedOptionLabels.length > 0 && !selectedOptionLabel)) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabel ?? selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const hasCustomAnswer = customAnswer.trim().length > 0;
  const selectedOptionLabel = hasCustomAnswer ? undefined : draft?.selectedOptionLabel;
  const selectedOptionLabels = hasCustomAnswer ? undefined : draft?.selectedOptionLabels;

  return {
    customAnswer,
    ...(selectedOptionLabel ? { selectedOptionLabel } : {}),
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function selectPendingUserInputOption(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const normalizedOptionLabel = normalizeDraftAnswer(optionLabel);
  if (!normalizedOptionLabel) {
    return {
      customAnswer: "",
    };
  }

  if (question.multiSelect === true) {
    const selectedOptionLabels = new Set(
      normalizeDraftAnswerList([
        ...(draft?.selectedOptionLabels ?? []),
        ...(draft?.selectedOptionLabel ? [draft.selectedOptionLabel] : []),
      ]),
    );

    if (selectedOptionLabels.has(normalizedOptionLabel)) {
      selectedOptionLabels.delete(normalizedOptionLabel);
    } else {
      selectedOptionLabels.add(normalizedOptionLabel);
    }

    const orderedOptionLabels = question.options
      .map((option) => normalizeDraftAnswer(option.label))
      .filter((label): label is string => label !== null);

    return {
      customAnswer: "",
      ...(orderedOptionLabels.length > 0
        ? {
            selectedOptionLabels: orderedOptionLabels.filter((label) =>
              selectedOptionLabels.has(label),
            ),
          }
        : {}),
    };
  }

  return {
    selectedOptionLabel: normalizedOptionLabel,
    customAnswer: "",
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(draftAnswers[question.id], question);
    if (!hasResolvedPendingUserInputAnswer(answer)) {
      return null;
    }
    if (Array.isArray(answer)) {
      answers[question.id] = [...answer];
      continue;
    }
    if (typeof answer !== "string") {
      return null;
    }
    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return hasResolvedPendingUserInputAnswer(
      resolvePendingUserInputAnswer(draftAnswers[question.id], question),
    )
      ? count + 1
      : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) =>
      !hasResolvedPendingUserInputAnswer(
        resolvePendingUserInputAnswer(draftAnswers[question.id], question),
      ),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const selectedOptionLabel = normalizeDraftAnswer(activeDraft?.selectedOptionLabel) ?? undefined;
  const selectedOptionLabels = normalizeDraftAnswerList([
    ...(activeDraft?.selectedOptionLabels ?? []),
    ...(selectedOptionLabel ? [selectedOptionLabel] : []),
  ]);
  const resolvedAnswer = resolvePendingUserInputAnswer(activeDraft, activeQuestion ?? undefined);
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabel,
    selectedOptionLabels,
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputAnswers(questions, draftAnswers) !== null,
    canAdvance: hasResolvedPendingUserInputAnswer(resolvedAnswer),
  };
}
