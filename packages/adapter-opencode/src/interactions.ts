import type { InteractionRequest, InteractionResolution } from "@ace/protocol";
import { array, object, string, type Data } from "./data.ts";
export type Pending = { agent: string; item?: string; request: InteractionRequest };
export function request(
  type: string,
  p: Data,
  tool: string,
  planPath?: string,
  markdown = "",
): InteractionRequest {
  if (type === "permission.asked")
    return {
      kind: "approval",
      title: string(p.permission),
      description: array(p.patterns)
        .map((v) => string(v))
        .join(", "),
      options: [
        { id: "once", label: "Allow once", kind: "allow_once" },
        { id: "always", label: "Allow for session", kind: "allow_session" },
        { id: "reject", label: "Deny", kind: "deny" },
      ],
    };
  if (tool === "plan_exit")
    return {
      kind: "plan_review",
      markdown,
      title: "Review plan",
      ...(planPath ? { planPath } : {}),
    };
  return {
    kind: "question",
    questions: array(p.questions).map((q, i) => {
      const v = object(q);
      return {
        id: `${string(p.id)}#${i}`,
        text: string(v.question),
        header: string(v.header),
        options: array(v.options).map((o) => {
          const option = object(o);
          return {
            id: string(option.label),
            label: string(option.label),
            description: string(option.description),
          };
        }),
        multiSelect: v.multiple === true,
        allowOther: v.custom !== false,
      };
    }),
  };
}
export function resolution(type: string, p: Data, pending: Pending): InteractionResolution {
  if (pending.request.kind === "approval")
    return {
      kind: "approval",
      optionId: string(p.reply, "reject"),
      ...(typeof p.message === "string" ? { message: p.message } : {}),
    };
  if (pending.request.kind === "plan_review")
    return { kind: "plan_review", decision: type === "question.rejected" ? "reject" : "approve" };
  const answers = array(p.answers);
  return {
    kind: "question",
    answers: Object.fromEntries(
      pending.request.kind === "question"
        ? pending.request.questions.map((q, i) => [q.id, array(answers[i]).map((v) => string(v))])
        : [],
    ),
    ...(type === "question.rejected" ? { dismissed: true } : {}),
  };
}
