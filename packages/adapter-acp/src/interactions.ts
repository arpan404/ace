import {
  type ApprovalOption,
  InteractionRequest,
  InteractionResolution as ResolutionSchema,
  type InteractionResolution,
} from "@ace/protocol";
import { list, object, string, type Data } from "./data.ts";
import { leaseRedaction } from "./frame-redaction.ts";
import type { AcpQuirks } from "./quirks/types.ts";
import { mcpArguments, toolDetail } from "./tools.ts";
export function interactionRequest(
  method: string,
  params: Data,
  quirks: AcpQuirks,
): InteractionRequest | undefined {
  const antigravity = quirks.provider === "antigravity";
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
            options: options.map((o, index) => ({
              id: localOptionId(o, index),
              label: string(o["name"]),
            })),
            multiSelect: false,
            allowOther: false,
          },
        ],
      };
    else request = approvalRequest(call, options, quirks);
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
  const options = list(params["options"]).map(object);
  const selected = publishedOptionId(options, string(outcome["optionId"]));
  if (request.kind === "approval" && outcome["outcome"] === "selected")
    return { kind: "approval", optionId: selected };
  if (request.kind === "question") {
    if (method === "session/request_permission" && outcome["outcome"] === "selected")
      return {
        kind: "question",
        answers: {
          [string(object(params["toolCall"])["toolCallId"])]: [selected],
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
/**
 * The native answer to a validated resolution. `params` are the request's params as published
 * (lease secrets redacted) and as the agent sent them: published option ids map back here.
 */
export function encodeResolution(
  method: string,
  params: { published: Data; native: Data },
  resolution: InteractionResolution,
  request: InteractionRequest,
): Data {
  const published = list(params.published["options"]).map(object);
  const options = list(params.native["options"]).map(object);
  const native = (local: string) => nativeOptionId(published, options, local) ?? local;
  if (resolution.kind === "approval")
    return { outcome: { outcome: "selected", optionId: native(resolution.optionId) } };
  if (resolution.kind === "question") {
    if (resolution.dismissed)
      return {
        outcome: { outcome: method === "session/request_permission" ? "cancelled" : "skipped" },
      };
    if (method === "session/request_permission")
      return {
        outcome: {
          outcome: "selected",
          optionId: native(
            request.kind === "question"
              ? (resolution.answers[request.questions[0]?.id ?? ""]?.[0] ?? "")
              : "",
          ),
        },
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
/**
 * Any legal permission request reaches the person: oversized fields are bounded and native option
 * kinds outside ace's set take the nearest one. The complete native request stays in raw.
 */
function approvalRequest(call: Data, options: Data[], quirks: AcpQuirks): InteractionRequest {
  // One reading of the call for its transcript item and its approval.
  const detail = toolDetail(call, quirks);
  const input = object(call["rawInput"]);
  const paths = list(call["locations"])
    .map((location) => string(object(location)["path"]))
    .filter((path) => path.length > 0 && path.length <= limits.cwd)
    .slice(0, limits.paths);
  const mcp =
    detail.kind === "mcp" && detail.server && detail.tool
      ? { server: detail.server, tool: detail.tool }
      : undefined;
  const tool = mcp
    ? `mcp__${mcp.server}__${mcp.tool}`
    : detail.kind === "shell"
      ? "shell"
      : // ACP kinds and follow-along locations do not prove an exact file operation.
        // Preserve the category without impersonating a trusted provider Read tool.
        `acp/${string(call["kind"]) || "other"}`;
  return {
    kind: "approval",
    title: string(call["title"]) || tool,
    target: {
      tool: tool.slice(0, limits.tool),
      access:
        detail.kind === "shell"
          ? "execute"
          : (ownValue(accessByKind, string(call["kind"])) ?? "unknown"),
      input: mcp ? mcpArguments(input) : call["rawInput"],
      ...(detail.kind === "shell" && detail.command
        ? { command: boundedCommand(detail.command) }
        : {}),
      ...(detail.kind === "shell" && detail.cwd ? { cwd: detail.cwd.slice(0, limits.cwd) } : {}),
      paths,
    },
    ...(mcp ? { mcpServer: { name: mcp.server.slice(0, limits.tool), source: "acp" } } : {}),
    options: options.map((o, index) => ({
      id: localOptionId(o, index),
      label: string(o["name"]),
      kind: optionKind(string(o["kind"])),
    })),
  };
}
const ownValue = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
/**
 * A command past the bound says so in its own text, so a hidden suffix never reads as the whole
 * command. The complete command stays in the target's input and the raw request.
 */
const truncationNote = (hidden: number) =>
  `\n[command truncated: ${hidden} more characters not shown]`;
function boundedCommand(command: string): string {
  if (command.length <= limits.command) return command;
  // The note's own length depends on the count it names; settle it before cutting.
  let kept = limits.command - truncationNote(command.length).length;
  kept = limits.command - truncationNote(command.length - kept).length;
  return command.slice(0, kept) + truncationNote(command.length - kept);
}
/**
 * The id ace publishes for a native option. Frames are published with lease secrets redacted, so
 * an id that carried one is published by position and mapped back at the RPC boundary.
 */
function localOptionId(option: Data, index: number): string {
  const id = string(option["optionId"]);
  return id.includes(leaseRedaction) ? `ace-option:${index}` : id;
}
/** The native id of the option ace published as `local`, found by its place (see localOptionId). */
function nativeOptionId(published: Data[], native: Data[], local: string): string | undefined {
  const index = published.findIndex((option, i) => localOptionId(option, i) === local);
  return index < 0 ? undefined : string(native[index]?.["optionId"]);
}
/** The id ace published for the native option `native`, read from a published (redacted) frame. */
function publishedOptionId(options: Data[], native: string): string {
  const index = options.findIndex((option) => string(option["optionId"]) === native);
  return index < 0 ? native : localOptionId(options[index] ?? {}, index);
}
const limits = { tool: 256, command: 32768, cwd: 4096, paths: 128 };
const accessByKind: Record<string, "read" | "write" | "execute"> = {
  read: "read",
  edit: "write",
  delete: "write",
  move: "write",
  execute: "execute",
};
const optionKinds: Record<string, ApprovalOption["kind"]> = {
  allow_once: "allow_once",
  allow_session: "allow_session",
  allow_always: "allow_always",
  reject_once: "deny",
  reject_always: "deny_always",
  deny: "deny",
  deny_always: "deny_always",
  cancel: "cancel",
};
function optionKind(kind: string): ApprovalOption["kind"] {
  if (Object.hasOwn(optionKinds, kind)) return optionKinds[kind] ?? "other";
  // Any other native kind ("postpone", "block_once") is a neutral choice: shown with the
  // agent's own label, never offered as Allow or Deny, and never settling the call by itself.
  return "other";
}

/** Stable process-local request key, shared by the session and translator. */
export function interactionKey(id: string | number): string {
  return `request:${typeof id}:${id}`;
}

/** Pure validation shared by the I/O boundary; encoding only receives a validated choice. */
export function validateResolution(
  request: InteractionRequest,
  input: unknown,
): InteractionResolution {
  const resolution = ResolutionSchema.parse(input);
  if (request.kind !== resolution.kind)
    throw new Error("Interaction resolution kind does not match");
  if (
    resolution.kind === "approval" &&
    request.kind === "approval" &&
    !request.options.some((o) => o.id === resolution.optionId)
  )
    throw new Error("Unknown approval option");
  if (resolution.kind === "question" && request.kind === "question") {
    if (
      Object.keys(resolution.answers).some(
        (id) => !request.questions.some((question) => question.id === id),
      )
    )
      throw new Error("Unknown question ID");
    if (!resolution.dismissed)
      for (const question of request.questions) {
        const answers = resolution.answers[question.id] ?? [];
        if (
          answers.length === 0 ||
          (!question.multiSelect && answers.length > 1) ||
          answers.some((id) => !question.allowOther && !question.options.some((o) => o.id === id))
        )
          throw new Error("Invalid question answer");
      }
  }
  return resolution;
}
