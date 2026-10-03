import { z } from "zod";
import { InteractionResolution, type InteractionRequest, type Question } from "@ace/protocol";
import { list, object, string, type Data } from "./native.ts";
export function requestFor(name: string, input: Data, options: Data): InteractionRequest {
  if (name === "AskUserQuestion")
    return {
      kind: "question",
      questions: list(input["questions"]).map((value) => {
        const q = object(value);
        const question: Question = {
          id: string(q["question"]),
          text: string(q["question"]),
          multiSelect: q["multiSelect"] === true,
          allowOther: true,
          options: list(q["options"]).map((option) => {
            const o = object(option);
            const result: Question["options"][number] = {
              id: string(o["label"]),
              label: string(o["label"]),
            };
            if (typeof o["description"] === "string") result.description = o["description"];
            return result;
          }),
        };
        if (typeof q["header"] === "string") question.header = q["header"];
        return question;
      }),
    };
  if (name === "ExitPlanMode")
    return {
      kind: "plan_review",
      markdown: string(input["plan"]),
      ...(typeof input["planFilePath"] === "string" ? { planPath: input["planFilePath"] } : {}),
    };
  const suggestions = list(options["suggestions"]);
  const destinations = new Set(suggestions.map((value) => string(object(value)["destination"])));
  const labels: Record<string, string> = {
    session: "this session",
    cliArg: "this invocation",
    userSettings: "user settings",
    projectSettings: "project settings",
    localSettings: "local project settings",
  };
  const grant =
    suggestions.length > 0 &&
    options["suppressAlwaysAllowRule"] !== true &&
    [...destinations].every((destination) => labels[destination] !== undefined);
  const mcp = z
    .object({ name: z.string(), source: z.string() })
    .passthrough()
    .safeParse(options["mcpServer"]);
  return {
    kind: "approval",
    title: string(options["title"], string(options["displayName"], name)),
    ...(typeof options["description"] === "string"
      ? { description: options["description"] }
      : typeof options["decisionReason"] === "string"
        ? { description: options["decisionReason"] }
        : {}),
    ...(typeof options["defaultToNo"] === "boolean" ? { defaultToNo: options["defaultToNo"] } : {}),
    ...(typeof options["suppressAlwaysAllowRule"] === "boolean"
      ? { suppressAlwaysAllowRule: options["suppressAlwaysAllowRule"] }
      : {}),
    ...(mcp.success ? { mcpServer: mcp.data } : {}),
    permissionUpdates: suggestions,
    options: [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
      ...(grant
        ? [
            {
              id: "allow_updates",
              label: `Allow and update ${[...destinations].map((d) => labels[d]).join(" and ")}`,
              kind:
                destinations.size === 1 && destinations.has("session")
                  ? ("allow_session" as const)
                  : ("allow_always" as const),
            },
          ]
        : []),
    ],
  };
}
export function resolutionFor(
  request: InteractionRequest,
  value: unknown,
  canonical?: unknown,
): InteractionResolution {
  const parsed = InteractionResolution.safeParse(canonical);
  if (parsed.success && parsed.data.kind === request.kind) return parsed.data;
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
    return {
      kind: "plan_review",
      decision: allowed ? "approve" : result["interrupt"] === true ? "cancel" : "reject",
      feedback: message,
    };
  if (request.kind === "elicitation") return { kind: "elicitation", action: "cancel" };
  return { kind: "approval", optionId: allowed ? "allow_once" : "deny", message };
}
