import type { Question } from "@ace/protocol";

/** One answer to offer for a question, its "(Recommended)" suffix turned into a flag. */
export interface QuestionOption {
  id: string;
  label: string;
  description: string | undefined;
  recommended: boolean;
}

const recommendedSuffix = /\s*\(recommended\)\s*$/i;

/** Claude marks its suggested answer with "(Recommended)"; clients show it as a quiet tag. */
export function questionOptions(question: Question): QuestionOption[] {
  return question.options.map((option) => ({
    id: option.id,
    label: option.label.replace(recommendedSuffix, ""),
    description: option.description,
    recommended: recommendedSuffix.test(option.label),
  }));
}
