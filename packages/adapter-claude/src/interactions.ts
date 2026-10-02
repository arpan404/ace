import type { InteractionRequest, InteractionResolution } from "@ace/protocol";
import { list, object, string, type Data } from "./native.ts";
export function requestFor(name: string, input: Data, options: Data): InteractionRequest {
  if (name === "AskUserQuestion")
    return {
      kind: "question",
      questions: list(input["questions"]).map((value) => {
        const q = object(value);
        return {
          id: string(q["question"]),
          text: string(q["question"]),
          ...(typeof q["header"] === "string" ? { header: q["header"] } : {}),
          multiSelect: q["multiSelect"] === true,
          allowOther: true,
          options: list(q["options"]).map((value) => {
            const o = object(value);
            return {
              id: string(o["label"]),
              label: string(o["label"]),
              ...(typeof o["description"] === "string" ? { description: o["description"] } : {}),
            };
          }),
        };
      }),
    };
  if (name === "ExitPlanMode")
    return {
      kind: "plan_review",
      markdown: string(input["plan"]),
      ...(typeof input["planFilePath"] === "string" ? { planPath: input["planFilePath"] } : {}),
    };
  return {
    kind: "approval",
    title:
      string(options["displayName"], name) +
      (options["description"] ? ` ${string(options["description"])}` : ""),
    ...(typeof options["decisionReason"] === "string"
      ? { description: options["decisionReason"] }
      : {}),
    options: [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
      ...list(options["suggestions"]).map((_, i) => ({
        id: `allow_session:${i}`,
        label: "Allow for this session",
        kind: "allow_session" as const,
      })),
    ],
  };
}
export function resolutionFor(request: InteractionRequest, value: unknown): InteractionResolution {
  const result = object(value);
  const allowed = result["behavior"] === "allow";
  const message = string(result["message"]);
  if (request.kind === "question") {
    const answers = object(object(result["updatedInput"])["answers"]);
    return {
      kind: "question",
      answers: Object.fromEntries(
        Object.entries(answers).map(([k, v]) => [
          k,
          typeof v === "string" ? [v] : list(v).filter((x): x is string => typeof x === "string"),
        ]),
      ),
      ...(!allowed ? { dismissed: true } : {}),
    };
  }
  if (request.kind === "plan_review")
    return { kind: "plan_review", decision: allowed ? "approve" : "reject", feedback: message };
  if (request.kind === "elicitation") return { kind: "elicitation", action: "cancel" };
  return { kind: "approval", optionId: allowed ? "allow_once" : "deny", message };
}
