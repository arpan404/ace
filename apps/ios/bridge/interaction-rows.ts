import type { ThreadReader } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import { approvalCopy, questionOptions, questionTitle } from "@ace/ui-core";
import { approvalRow, preview } from "./presentation.ts";

/*
 * An interaction card's row: the spike's approval fields, plus the web's three approval verbs
 * (Allow once, Always allow, Deny) naming offered options by index, so large option sets are sent
 * once and every action keeps its exact canonical id. Questions carry their options and whether
 * the person may answer in their own words.
 */

const questionLimit = 8;
const optionLimit = 32;

function approval(interaction: Interaction, command: string) {
  if (interaction.request.kind !== "approval")
    return { heading: "", reason: "", risk: "", riskText: "", decisions: [], others: [] };
  const copy = approvalCopy(interaction.request, command ? { command } : {});
  const index = new Map(interaction.request.options.map((option, at) => [option, at]));
  const at = (option: (typeof interaction.request.options)[number]) => index.get(option) ?? -1;
  return {
    heading: preview(copy.heading),
    reason: preview(copy.reason ?? "", 2048),
    risk: copy.risk?.level ?? "",
    riskText: preview(copy.risk?.text ?? "", 256),
    decisions: copy.decisions.map((decision) => ({
      verb: decision.verb,
      option: at(decision.option),
      label: decision.label,
      scope: preview(decision.scope ?? "", 128),
      emphasis: decision.emphasis,
    })),
    others: copy.others.map((other) => ({
      option: at(other.option),
      label: preview(other.label, 128),
    })),
  };
}

function questions(interaction: Interaction) {
  if (interaction.request.kind !== "question") return [];
  return interaction.request.questions.slice(0, questionLimit).map((question) => ({
    id: question.id,
    header: preview(question.header ?? "", 128),
    text: preview(question.text, 2048),
    multiSelect: question.multiSelect,
    allowOther: question.allowOther,
    options: questionOptions(question)
      .slice(0, optionLimit)
      .map((option) => ({
        id: option.id,
        label: preview(option.label, 128),
        detail: preview(option.description ?? "", 512),
        recommended: option.recommended,
      })),
  }));
}

export function interactionRow(interaction: Interaction, reader: ThreadReader) {
  const base = approvalRow(interaction, reader);
  const request = interaction.request;
  return {
    ...base,
    ...(request.kind === "question" ? { title: preview(questionTitle(request.questions)) } : {}),
    // Questions past what a phone card shows are answered on a larger screen.
    unanswerable:
      request.kind === "question" &&
      (request.questions.length > questionLimit ||
        request.questions.some((question) => question.options.length > optionLimit)),
    ...approval(interaction, base.command),
    questions: questions(interaction),
  };
}
