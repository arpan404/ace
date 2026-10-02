import { InteractionRequest, type InteractionResolution } from "@ace/protocol";
import { list, object, string, type Data } from "./data.ts";
export function interactionRequest(
  method: string,
  params: Data,
  antigravity: boolean,
): InteractionRequest | undefined {
  const call = object(params["toolCall"]);
  let request: unknown;
  if (method === "cursor/create_plan")
    request = {
      kind: "plan_review",
      title: string(params["name"]),
      summary: string(params["overview"]),
      markdown: string(params["plan"]),
      ...(params["todos"] ? { todos: params["todos"] } : {}),
    };
  else if (method === "cursor/ask_question")
    request = {
      kind: "question",
      questions: list(params["questions"])
        .map(object)
        .map((q) => ({
          id: string(q["id"]),
          text: string(q["prompt"]),
          options: q["options"],
          multiSelect: q["allowMultiple"] === true,
          allowOther: false,
        })),
    };
  else if (method === "session/request_permission") {
    const options = list(params["options"]).map(object);
    if (antigravity && string(call["toolCallId"]).startsWith("interaction_"))
      request = {
        kind: "question",
        questions: [
          {
            id: string(call["toolCallId"]),
            text: string(call["title"]),
            options: options.map((o) => ({ id: string(o["optionId"]), label: string(o["name"]) })),
            multiSelect: false,
            allowOther: false,
          },
        ],
      };
    else
      request = {
        kind: "approval",
        title: string(call["title"]),
        options: options.map((o) => ({
          id: string(o["optionId"]),
          label: string(o["name"]),
          kind:
            o["kind"] === "reject_once"
              ? "deny"
              : o["kind"] === "reject_always"
                ? "deny_always"
                : o["kind"],
        })),
      };
  }
  const parsed = InteractionRequest.safeParse(request);
  return parsed.success ? parsed.data : undefined;
}
export function decodeResolution(
  method: string,
  params: Data,
  response: Data,
  request: InteractionRequest,
): InteractionResolution | undefined {
  const outcome = object(response["outcome"]);
  if (request.kind === "approval" && outcome["outcome"] === "selected")
    return { kind: "approval", optionId: string(outcome["optionId"]) };
  if (request.kind === "question") {
    if (method === "session/request_permission" && outcome["outcome"] === "selected")
      return {
        kind: "question",
        answers: {
          [string(object(params["toolCall"])["toolCallId"])]: [string(outcome["optionId"])],
        },
      };
    if (outcome["outcome"] === "skipped") return { kind: "question", answers: {}, dismissed: true };
    if (outcome["outcome"] === "answered")
      return {
        kind: "question",
        answers: Object.fromEntries(
          list(outcome["answers"])
            .map(object)
            .map((a) => [
              string(a["questionId"]),
              list(a["selectedOptionIds"]).filter((v): v is string => typeof v === "string"),
            ]),
        ),
      };
  }
  if (
    request.kind === "plan_review" &&
    ["accepted", "rejected"].includes(string(outcome["outcome"]))
  )
    return {
      kind: "plan_review",
      decision: outcome["outcome"] === "accepted" ? "approve" : "reject",
      ...(typeof outcome["reason"] === "string" ? { feedback: outcome["reason"] } : {}),
    };
  return undefined;
}
export function encodeResolution(method: string, resolution: InteractionResolution): Data {
  if (resolution.kind === "approval")
    return { outcome: { outcome: "selected", optionId: resolution.optionId } };
  if (resolution.kind === "question") {
    if (resolution.dismissed)
      return {
        outcome: { outcome: method === "session/request_permission" ? "cancelled" : "skipped" },
      };
    if (method === "session/request_permission")
      return {
        outcome: { outcome: "selected", optionId: Object.values(resolution.answers)[0]?.[0] ?? "" },
      };
    return {
      outcome: {
        outcome: "answered",
        answers: Object.entries(resolution.answers).map(([questionId, selectedOptionIds]) => ({
          questionId,
          selectedOptionIds,
        })),
      },
    };
  }
  if (resolution.kind === "plan_review")
    return {
      outcome: {
        outcome:
          resolution.decision === "approve"
            ? "accepted"
            : resolution.decision === "reject"
              ? "rejected"
              : "cancelled",
        ...(resolution.feedback ? { reason: resolution.feedback } : {}),
      },
    };
  throw new Error("ACP does not support this interaction resolution");
}
/** Stable process-local request key, shared by the session and translator. */
export function interactionKey(id: string | number): string {
  return `request:${typeof id}:${id}`;
}
