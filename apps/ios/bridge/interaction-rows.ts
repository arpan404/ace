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
import { sentSummarized } from "@ace/projection/interaction-summary";
import { approvalRow, preview } from "./presentation.ts";
import { requestRow } from "./thread-requests.ts";
import { grantName } from "./approval-names.ts";
import {
  declinesOnly,
  summarizedNote,
  withWholeRequest,
  type WholeRequestState,
} from "./summarized-requests.ts";

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

function approval(interaction: Interaction, command: string, loadedWhole = false) {
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
    reason: preview(copy.reason ?? "", loadedWhole ? 256 * 1024 : 2048),
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

function questions(interaction: Interaction, loadedWhole = false) {
  if (interaction.request.kind !== "question") return [];
  const maxQuestions = loadedWhole ? 64 : questionLimit;
  const maxOptions = loadedWhole ? 256 : optionLimit;
  const textLimit = loadedWhole ? 64 * 1024 : 2048;
  const detailLimit = loadedWhole ? 16 * 1024 : 512;
  return interaction.request.questions.slice(0, maxQuestions).map((question) => ({
    id: question.id,
    header: preview(question.header ?? "", 128),
    text: preview(question.text, textLimit),
    multiSelect: question.multiSelect,
    allowOther: question.allowOther,
    options: questionOptions(question)
      .slice(0, maxOptions)
      .map((option) => ({
        id: option.id,
        label: preview(option.label, 128),
        detail: preview(option.description ?? "", detailLimit),
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

export function interactionRow(
  asked: Interaction,
  reader: RequestReader,
  fallback = "",
  whole?: WholeRequestState,
) {
  const isSummarized = sentSummarized(asked);
  const loadedWhole = whole?.status === "loaded";
  // A summarized request offers only declines until the phone reads its whole payload (ADR 0157).
  const summarized = summarizedNote(asked, whole);
  const full = loadedWhole ? withWholeRequest(asked, whole) : asked;
  const interaction = summarized ? declinesOnly(full) : full;
  const base = approvalRow(interaction, reader, fallback, loadedWhole);
  const request = interaction.request;
  const row = requestRow(request, loadedWhole);
  const maxQuestions = loadedWhole ? 64 : questionLimit;
  const maxOptions = loadedWhole ? 256 : optionLimit;
  const wholeState = isSummarized ? (whole?.status ?? "unread") : undefined;
  const wholeRetryable = whole?.status === "failed" ? whole.retryable : undefined;
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
    ...(wholeState ? { wholeState } : {}),
    ...(wholeRetryable !== undefined ? { wholeRetryable } : {}),
    // The version on screen: an answer names it, so a tap on an older one is refused.
    ...(whole?.status === "loaded" ? { wholeVersion: whole.version } : {}),
    summarized,
    // Questions past what a phone card shows, or summarized and not yet loaded, are unanswerable.
    unanswerable:
      request.kind === "question" &&
      (summarized !== "" ||
        request.questions.length > maxQuestions ||
        request.questions.some((question) => question.options.length > maxOptions)),
    ...approval(interaction, base.command, loadedWhole),
    questions: questions(interaction, loadedWhole),
    strip: summarized
      ? { ...stripOf(interaction, reader, base.command), detail: summarized }
      : stripOf(interaction, reader, base.command),
  };
}
