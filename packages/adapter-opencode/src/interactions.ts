import type { Fact } from "@ace/core";
import type { TranslationState } from "./translation-state.ts";
import type { InteractionRequest, InteractionResolution } from "@ace/protocol";
import { array, object, raw, string, type Data } from "./data.ts";
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

export function translateInteraction(
  state: TranslationState,
  type: string,
  p: Data,
  data: unknown,
): Fact[] {
  const id = string(p.sessionID);
  const agent = state.key(id);
  const s = state.session(id);
  const facts: Fact[] = [];
  if (type === "permission.asked" || type === "question.asked") {
    const interaction = string(p.id);
    if (!interaction) return [...state.notice(data, type)];
    if (state.pending.has(interaction)) return state.metadata(type, interaction, data);
    const call = string(object(p.tool).callID);
    const part = state.getPart(call);
    const pending: Pending = {
      agent,
      ...(call ? { item: call } : {}),
      request: request(type, p, string(part?.data.tool), s.planPath, s.planMarkdown),
    };
    state.pending.set(interaction, pending);
    facts.push({
      type: "interaction.opened",
      agent,
      interaction,
      blocking: true,
      request: pending.request,
      ...(call ? { item: call } : {}),
      raw: raw(type, data),
    });
    if (call)
      facts.push({
        type: "item.upsert",
        agent,
        item: call,
        draft: { type: "tool_call", call: { status: "awaiting_approval" } },
      });
    return facts;
  }
  if (["permission.replied", "question.replied", "question.rejected"].includes(type)) {
    const interaction = string(p.requestID);
    const pending = state.pending.get(interaction);
    if (!pending) return [...state.notice(data, type)];
    state.pending.delete(interaction);
    return [
      ...state.metadata(type, interaction, data),
      {
        type: "interaction.closed",
        interaction,
        state: "resolved",
        resolution: resolution(type, p, pending),
      },
    ];
  }

  return state.notice(data, type);
}

/** Pure outbound command mapping; the session only performs its HTTP request. */
export function nativeResolution(
  interaction: string,
  choice: InteractionResolution,
  pending: unknown,
): { path: string; body: Data } {
  if (choice.kind === "approval") {
    if (!["once", "always", "reject"].includes(choice.optionId))
      throw new Error("Unsupported OpenCode approval option");
    return {
      path: `/permission/${encodeURIComponent(interaction)}/reply`,
      body: {
        reply: choice.optionId,
        ...(choice.message ? { message: choice.message } : {}),
      },
    };
  }
  if (choice.kind === "question") {
    if (choice.dismissed)
      return { path: `/question/${encodeURIComponent(interaction)}/reject`, body: {} };
    const questions = array(object(pending).questions);
    if (!questions.length) throw new Error("OpenCode question is no longer pending");
    return {
      path: `/question/${encodeURIComponent(interaction)}/reply`,
      body: { answers: questions.map((_, i) => choice.answers[`${interaction}#${i}`] ?? []) },
    };
  }
  if (choice.kind === "plan_review")
    return {
      path: `/question/${encodeURIComponent(interaction)}/${choice.decision === "approve" ? "reply" : "reject"}`,
      body: choice.decision === "approve" ? { answers: [["Yes"]] } : {},
    };
  throw new Error("OpenCode does not support elicitation choice");
}
