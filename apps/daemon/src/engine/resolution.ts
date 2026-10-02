import type { InteractionRequest, InteractionResolution } from "@ace/protocol";

/** Validate against the offered request before claiming first-answer ownership. */
export function validResolution(
  request: InteractionRequest,
  resolution: InteractionResolution,
): boolean {
  if (request.kind !== resolution.kind) return false;
  if (request.kind === "approval" && resolution.kind === "approval")
    return request.options.some((option) => option.id === resolution.optionId);
  if (request.kind !== "question" || resolution.kind !== "question") return true;
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  if (resolution.dismissed) return Object.keys(resolution.answers).length === 0;
  if (Object.keys(resolution.answers).length !== questions.size) return false;
  return Object.entries(resolution.answers).every(([id, answers]) => {
    const question = questions.get(id);
    return (
      question !== undefined &&
      answers.length > 0 &&
      (question.multiSelect || answers.length === 1) &&
      new Set(answers).size === answers.length &&
      answers.every(
        (answer) =>
          question.options.some((option) => option.id === answer) ||
          (question.allowOther && answer.trim().length > 0),
      )
    );
  });
}
