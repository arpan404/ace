import type { Fact } from "@ace/core";
import type { InteractionRequest, InteractionResolution } from "@ace/protocol";
import { array, object, raw, string, type Data } from "./data.ts";
import { toolKey } from "./native-content.ts";
import type { NativeState } from "./native-state.ts";
export function formRequest(form: Data): InteractionRequest {
  const fields = array(form.fields).map(object);
  if (
    object(form.metadata).kind === "question" &&
    fields.length &&
    fields.every((f) => ["string", "multiselect"].includes(string(f.type)))
  )
    return {
      kind: "question",
      questions: fields.map((f) => ({
        id: string(f.key),
        text: string(f.description, string(f.title)),
        header: string(f.title),
        options: array(f.options).map((v) => {
          const o = object(v);
          return {
            id: string(o.value),
            label: string(o.label),
            description: string(o.description),
          };
        }),
        multiSelect: f.type === "multiselect",
        allowOther: f.custom === true,
      })),
    };
  return {
    kind: "elicitation",
    server: "OpenCode",
    message: string(form.title),
    schema: { fields: form.fields, metadata: form.metadata },
  };
}
export function interaction(state: NativeState, type: string, p: Data, evidence: unknown): Fact[] {
  const form = type === "form.created" ? object(p.form) : p;
  const id = string(form.id, string(p.requestID)),
    session = string(form.sessionID),
    key = `${type.startsWith("permission") ? "permission" : "form"}:${session}:${id}`;
  if (!id || !state.agents.has(session)) return [];
  if (type === "permission.asked" || type === "form.created") {
    if (state.pending.has(key)) return [];
    if (state.pending.size >= 1024) throw new Error("OpenCode interaction limit");
    state.pending.set(key, { session, data: form, type });
    const source = object(form.source ?? object(form.metadata).tool),
      item =
        source.type === "tool" || source.id
          ? toolKey(session, string(source.messageID), string(source.id))
          : undefined;
    const request: InteractionRequest =
      type === "permission.asked"
        ? {
            kind: "approval",
            title: string(form.action),
            description: array(form.resources)
              .map((v) => string(v))
              .join(", "),
            options: [
              { id: "once", label: "Allow once", kind: "allow_once" },
              { id: "always", label: "Allow for project", kind: "allow_always" },
              { id: "reject", label: "Deny", kind: "deny" },
            ],
          }
        : formRequest(form);
    return [
      {
        type: "interaction.opened",
        agent: state.key(session),
        interaction: key,
        blocking: true,
        request,
        ...(item ? { item } : {}),
        raw: raw(type, evidence),
      },
    ];
  }
  const pending = state.pending.get(key);
  if (!pending) return [];
  state.pending.delete(key);
  let resolution: InteractionResolution;
  if (type === "permission.replied")
    resolution = {
      kind: "approval",
      optionId: string(p.reply),
      ...(typeof p.message === "string" ? { message: p.message } : {}),
    };
  else if (formRequest(pending.data).kind === "question") {
    const answer = object(p.answer);
    resolution = {
      kind: "question",
      answers: Object.fromEntries(
        Object.entries(answer).map(([fieldKey, value]) => [
          fieldKey,
          typeof value === "string" ? [value] : array(value).map((v) => string(v)),
        ]),
      ),
      ...(type === "form.cancelled"
        ? {
            dismissed: true,
            ...(typeof p.message === "string" ? { feedback: p.message.slice(0, 8192) } : {}),
          }
        : {}),
    };
  } else
    resolution = {
      kind: "elicitation",
      action: type === "form.cancelled" ? "cancel" : "accept",
      content:
        type === "form.cancelled"
          ? typeof p.message === "string"
            ? { feedback: p.message }
            : {}
          : p.answer,
    };
  return [
    {
      type: "interaction.closed",
      interaction: key,
      state: type === "form.cancelled" ? "cancelled" : "resolved",
      resolution,
    },
  ];
}
export function nativeResolution(
  choice: InteractionResolution,
  pending: { session: string; data: Data; type: string },
) {
  const id = string(pending.data.id),
    sessionID = pending.session;
  if (pending.type === "permission.asked") {
    if (choice.kind !== "approval" || !["once", "always", "reject"].includes(choice.optionId))
      throw new Error("Unsupported OpenCode permission choice");
    const decision: "once" | "always" | "reject" =
      choice.optionId === "once" ? "once" : choice.optionId === "always" ? "always" : "reject";
    return {
      kind: "permission" as const,
      sessionID,
      requestID: id,
      decision,
      message: choice.message,
    };
  }
  if (choice.kind === "question") {
    const answer: Record<string, string | string[]> = {};
    for (const field of array(pending.data.fields).map(object)) {
      const key = string(field.key),
        values = choice.answers[key] ?? [];
      answer[key] = field.type === "multiselect" ? values : (values[0] ?? "");
    }
    return {
      kind: "form" as const,
      sessionID,
      formID: id,
      cancel: choice.dismissed === true,
      message: choice.feedback,
      answer,
    };
  }
  if (choice.kind === "elicitation")
    return {
      kind: "form" as const,
      sessionID,
      formID: id,
      cancel: choice.action !== "accept",
      message:
        typeof object(choice.content).feedback === "string"
          ? string(object(choice.content).feedback)
          : undefined,
      answer: object(choice.content),
    };
  throw new Error("OpenCode plan review is unsupported");
}
