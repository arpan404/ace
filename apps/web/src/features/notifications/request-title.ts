import type { InteractionRequest } from "@ace/protocol";

export function requestTitle(request: InteractionRequest): string {
  switch (request.kind) {
    case "approval":
      return request.title;
    case "question":
      return request.questions[0]?.text ?? "Question";
    case "plan_review":
      return request.title ?? "Review the plan";
    case "elicitation":
      return request.message;
  }
}
