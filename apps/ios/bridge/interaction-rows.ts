import type { ThreadReader } from "@ace/client";
import type { Interaction } from "@ace/protocol";
import {
  agentName,
  approvalCopy,
  browserHelpTitle,
  lostChildAsk,
  lostChildCopy,
  questionOptions,
  questionTitle,
} from "@ace/ui-core";
import {
  approvalStripLine,
  browserHelpStripLine,
  formStripLine,
  lostChildStripLine,
  planReviewLine,
  planStripLine,
  questionStripLine,
  type StripLine,
} from "@ace/ui-core/mobile";
import { approvalRow, preview } from "./presentation.ts";
import { requestRow } from "./thread-requests.ts";
import { grantName } from "./approval-names.ts";
import { declinesOnly, summarizedNote } from "./summarized-requests.ts";

/*
 * An interaction card's row: the spike's approval fields, plus the web's three approval verbs
 * (Allow once, Always allow, Deny) naming offered options by index, so large option sets are sent
 * once and every action keeps its exact canonical id. Questions carry their options and whether
 * the person may answer in their own words.
 */

const questionLimit = 8;
/** The raw part the daemon puts on a request it mirrors from another machine. */
const mirrored = "ace.machine.request";
const optionLimit = 32;

function approval(interaction: Interaction, command: string) {
  if (interaction.request.kind !== "approval")
    return { heading: "", reason: "", risk: "", riskText: "", decisions: [], others: [] };
  const plain = approvalCopy(interaction.request, command ? { command } : {});
  // The daemon's request about a lost child answers with Stop tracking, as the child's row does.
  const lost = lostChildAsk(interaction);
  const copy = lost ? lostChildCopy(plain, lost) : plain;
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
      /** The action named once with what it covers ("Always allow here"), for a pressable word. */
      name: preview(grantName(decision.label, decision.scope ?? ""), 160),
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

/** A strip line cut to what a phone frame carries. */
const clip = (strip: StripLine): StripLine => ({
  lead: strip.lead,
  sentence: preview(strip.sentence, 256),
  payload: preview(strip.payload, 512),
  detail: preview(strip.detail, 512),
});

/**
 * The request as its strip above the composer says it (`@ace/ui-core/mobile` strip lines): who
 * asks, by the asking agent's name and provider mark, and the one line under it.
 */
/** What a request row reads around it: its tool call, its agent and the thread's provider. */
export type RequestReader = Pick<ThreadReader, "item" | "agent"> & {
  readonly thread: { readonly provider: string } | undefined;
};

function stripOf(interaction: Interaction, reader: RequestReader, command: string): StripLine {
  const agent = reader.agent(interaction.agentId);
  const provider = agent?.native?.provider ?? reader.thread?.provider ?? "";
  const who = agent ? agentName(agent) : "The agent";
  const request = interaction.request;
  switch (request.kind) {
    case "approval": {
      const lost = lostChildAsk(interaction);
      if (lost) return clip(lostChildStripLine(lost, request.description ?? "", provider));
      return clip(
        approvalStripLine(
          approvalCopy(request, command ? { command } : {}),
          request.target,
          who,
          provider,
        ),
      );
    }
    case "question":
      return clip(
        questionStripLine(
          request.questions.map((question) => question.text),
          who,
          provider,
        ),
      );
    case "plan_review":
      return clip(planStripLine(planReviewLine(request), provider));
    case "elicitation":
      return clip(formStripLine(request.message, who, provider));
    case "browser_help":
      return clip(browserHelpStripLine(browserHelpTitle(request), who, provider));
    default:
      return clip({ lead: { provider }, sentence: `${who} needs you`, payload: "", detail: "" });
  }
}

export function interactionRow(asked: Interaction, reader: RequestReader, fallback = "") {
  // A summarized request offers only declines: the phone never shows it whole (ADR 0157).
  const summarized = summarizedNote(asked);
  const interaction = summarized ? declinesOnly(asked) : asked;
  const base = approvalRow(interaction, reader, fallback);
  const request = interaction.request;
  const row = requestRow(request);
  return {
    ...base,
    ...(request.kind === "question" ? { title: preview(questionTitle(request.questions)) } : {}),
    ...row,
    // Mirrored from another machine (`apps/daemon/src/machines/mirror.ts`): its tab is there, not
    // in this thread's browser, so the card doesn't offer to open it here.
    ...(row.help
      ? { help: { ...row.help, elsewhere: asked.raw.some((part) => part.type === mirrored) } }
      : {}),
    ...(summarized && row.plan ? { plan: { ...row.plan, truncated: true } } : {}),
    ...(summarized && row.form ? { form: { ...row.form, unsupported: true, fields: [] } } : {}),
    ...(summarized ? { truncated: true } : {}),
    summarized,
    // Questions past what a phone card shows, or summarized, are answered on a larger screen.
    unanswerable:
      request.kind === "question" &&
      (summarized !== "" ||
        request.questions.length > questionLimit ||
        request.questions.some((question) => question.options.length > optionLimit)),
    ...approval(interaction, base.command),
    questions: questions(interaction),
    strip: summarized
      ? { ...stripOf(interaction, reader, base.command), detail: summarized }
      : stripOf(interaction, reader, base.command),
  };
}
