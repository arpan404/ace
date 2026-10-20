import { cardEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useState, type KeyboardEvent, type ReactNode } from "react";
import { useAgent, useInteraction, useItem, useThreadMeta } from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import {
  agentName,
  approvalByKey,
  approvalCopy,
  browserHelpTitle,
  displayCommand,
  questionTitle,
  requestIdentity,
} from "@ace/ui-core";
import { ChatTeardropDotsIcon, CheckIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { ApprovalHeading, ApprovalRequest } from "@/components/approval-request.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { AnsweredQuestionCard, closedMeta } from "./answered-question.tsx";
import { answerStore, useLocalAnswer, type LocalAnswer } from "./answers.ts";
import { useAnswerSender } from "./answer-sender.ts";
import { QuestionForm } from "./question-form.tsx";
import { Elicitation } from "./elicitation.tsx";
import { PlanReview } from "./plan-review.tsx";
import { BrowserHelp } from "./browser-help.tsx";
import type { Answer } from "./answer.ts";
import { useEarlierAnswer } from "./use-earlier-answer.ts";

/** Typing a digit in these goes into the field, not to an option. */
const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" &&
      !["radio", "checkbox"].includes((target as HTMLInputElement).type)));

/** How the card is drawn: a bordered card of its own, or inside a surface that frames it. */
const frames = {
  card: `rounded-lg px-[18px] py-4 ${cardEdge}`,
  attached: "pb-1",
  inline: "py-2",
};
export type InteractionFrame = keyof typeof frames;

/**
 * A request from an agent, answered in place: approve or deny a command, answer questions,
 * review a plan. A question answered here reads as the question and the answer it got; a
 * request offered again after it was answered reads as answered (A3). `frame` "attached" drops
 * the card's own border for a surface that has one (the composer's attached card), and `aside`
 * goes at the end of its top line (that card's "1 of 3").
 */
export function InteractionCard(props: {
  threadId: string;
  interactionId: string;
  frame?: InteractionFrame | undefined;
  aside?: ReactNode;
  /** Who asks, when the parent names it (a delegated child, "general assistant"). */
  asker?: string | undefined;
  /** Keep a stable focus target while the decision controls are replaced. */
  onControlsChange?(): void;
  /** Opened from a notice about this request: a browser request shows its tab at once. */
  targeted?: boolean | undefined;
}) {
  const frame = frames[props.frame ?? "card"];
  const interaction = useInteraction(props.threadId, props.interactionId);
  const agent = useAgent(props.threadId, interaction?.agentId ?? "");
  const identity = interaction ? requestIdentity(interaction) : undefined;
  const local = useLocalAnswer(props.interactionId, identity);
  const earlier = useEarlierAnswer(props.threadId, interaction);
  const [reopened, setReopened] = useState(false);
  const sender = useAnswerSender({
    interactionId: props.interactionId,
    identity,
    questions: interaction?.request.kind === "question" ? interaction.request.questions : [],
  });
  const { failed } = sender;
  const answer: Answer = (resolution) => {
    props.onControlsChange?.();
    setReopened(false);
    sender.answer(resolution);
  };
  if (!interaction) return null;
  const asker = props.asker ?? (agent ? agentName(agent) : "The agent");
  const pending = interaction.state === "pending";
  const request = interaction.request;
  if (request.kind === "question") {
    if (!pending)
      return (
        <AnsweredQuestionCard
          className={frame}
          asker={asker}
          questions={request.questions}
          resolution={interaction.resolution ?? local?.resolution}
          meta={closedMeta(interaction, local?.state === "sent")}
        />
      );
    if (local && !reopened)
      return (
        <AnsweredQuestionCard
          className={frame}
          asker={asker}
          questions={request.questions}
          resolution={local.resolution}
          meta={
            local.state === "sending"
              ? { kind: "sending" }
              : { kind: "answered", by: "you", at: local.at }
          }
          onAnswerAgain={
            local.state === "sent"
              ? () => {
                  props.onControlsChange?.();
                  answerStore.forget(interaction.id);
                  setReopened(true);
                }
              : undefined
          }
        />
      );
    if (earlier && !reopened)
      return (
        <AnsweredQuestionCard
          className={frame}
          asker={asker}
          questions={request.questions}
          resolution={earlier.resolution}
          meta={{ kind: "earlier", at: earlier.closedAt }}
          onAnswerAgain={() => {
            props.onControlsChange?.();
            setReopened(true);
          }}
        />
      );
  }
  if (!pending) return null;
  return (
    <OpenRequest
      className={frame}
      aside={props.aside}
      threadId={props.threadId}
      interaction={interaction}
      asker={asker}
      answer={answer}
      failed={failed}
      local={reopened ? undefined : (local ?? earlierAsLocal(earlier))}
      targeted={props.targeted}
      onAnswerAgain={() => {
        props.onControlsChange?.();
        answerStore.forget(interaction.id);
        setReopened(true);
      }}
    />
  );
}

function earlierAsLocal(earlier: Interaction | undefined): LocalAnswer | undefined {
  return earlier?.resolution
    ? {
        resolution: earlier.resolution,
        state: "sent",
        at: earlier.closedAt ?? 0,
        identity: requestIdentity(earlier),
      }
    : undefined;
}

function OpenRequest(props: {
  className: string;
  aside: ReactNode;
  threadId: string;
  interaction: Interaction;
  asker: string;
  answer: Answer;
  failed: string | undefined;
  local: LocalAnswer | undefined;
  targeted?: boolean | undefined;
  onAnswerAgain(): void;
}) {
  const { interaction, local, answer, failed } = props;
  const call = useItem(props.threadId, interaction.toolCallId ?? "");
  const mode = useThreadMeta(props.threadId)?.permission?.effective;
  const request = interaction.request;
  const sending = local?.state === "sending";
  const command =
    call?.type === "tool_call" && call.call.detail.kind === "shell"
      ? displayCommand(call.call.detail).command
      : undefined;
  const copy = request.kind === "approval" ? approvalCopy(request, { mode, command }) : undefined;
  const title =
    request.kind === "approval"
      ? (copy?.title ?? request.title)
      : request.kind === "question"
        ? questionTitle(request.questions)
        : request.kind === "plan_review"
          ? (request.title ?? "Review the plan")
          : request.kind === "browser_help"
            ? browserHelpTitle(request)
            : request.message;
  const kind = {
    approval: "Approval",
    question: "Question",
    plan_review: "Plan review",
    elicitation: request.kind === "elicitation" ? request.server : "Request",
    browser_help: "Browser",
  }[request.kind];
  const decisions = copy?.decisions;
  const chosen =
    local?.resolution.kind === "approval" && request.kind === "approval"
      ? request.options.find(
          (option) =>
            local.resolution.kind === "approval" && option.id === local.resolution.optionId,
        )
      : undefined;
  const [nudged, setNudged] = useState<string>();
  const onKeyDown = (event: KeyboardEvent) => {
    if (!decisions || sending || chosen || typing(event.target)) return;
    const digit = Number.parseInt(event.key, 10);
    const decision = Number.isNaN(digit) ? undefined : decisions[digit - 1];
    if (!decision || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    // A default-to-no request is approved only by a click (or Enter on its focused button).
    if (request.kind === "approval" && !approvalByKey(request, decision.option, copy?.risk))
      return setNudged(decision.label);
    answer({ kind: "approval", optionId: decision.option.id });
  };
  return (
    <article tabIndex={-1} aria-label={title} onKeyDown={onKeyDown} className={props.className}>
      {request.kind !== "approval" && (
        <p
          className={cn(
            "flex min-h-6 items-center gap-[7px] text-xs",
            request.kind === "question" ? "text-muted-foreground" : "text-subtle-foreground",
          )}
        >
          {request.kind === "question" ? (
            <Icon icon={ChatTeardropDotsIcon} size={14} />
          ) : (
            <Dot tone="needs-you" />
          )}
          {request.kind === "question" ? props.asker : `${props.asker} · ${kind}`}
          <span className="ml-auto flex items-center gap-3">{props.aside}</span>
        </p>
      )}
      {request.kind !== "question" ? (
        <div className="mt-2 mb-2.5 flex items-start gap-2">
          <h3
            className={cn(
              "min-w-0 flex-1 font-medium",
              copy?.command
                ? "flex items-center gap-1.5 text-xs text-muted-foreground"
                : "text-md leading-[1.35] tracking-[-0.005em]",
            )}
          >
            {copy?.command ? (
              // The command itself shows below, in a code block.
              "Run command"
            ) : copy ? (
              <ApprovalHeading copy={copy} />
            ) : (
              title
            )}
          </h3>
          {request.kind === "approval" && props.aside && (
            <div className="shrink-0">{props.aside}</div>
          )}
        </div>
      ) : null}
      {request.kind === "approval" && copy && (
        <>
          <ApprovalRequest
            copy={copy}
            presentation="compact"
            disabled={sending}
            numbered
            keyed={(option) => approvalByKey(request, option, copy.risk)}
            onAnswer={(picked) => answer({ kind: "approval", optionId: picked.option.id })}
            answered={
              chosen && (
                <Chosen
                  label={
                    decisions?.find((decision) => decision.option.id === chosen.id)?.label ??
                    chosen.label
                  }
                  sending={sending}
                  onAgain={props.onAnswerAgain}
                />
              )
            }
          />
          {nudged && !chosen && (
            <p role="status" className="mt-2 text-xs text-subtle-foreground">
              Read the request, then click {nudged} to allow it.
            </p>
          )}
        </>
      )}
      {request.kind === "question" && (
        <QuestionForm
          interactionId={interaction.id}
          asker={props.asker}
          questions={request.questions}
          disabled={sending}
          onAnswer={answer}
        />
      )}
      {request.kind === "plan_review" && (
        <PlanReview disabled={sending} onAnswer={answer}>
          <Prose text={request.markdown} className="text-ui leading-[1.55]" />
        </PlanReview>
      )}
      {request.kind === "elicitation" && (
        <Elicitation request={request} disabled={sending} onAnswer={answer} />
      )}
      {request.kind === "browser_help" && (
        <BrowserHelp
          threadId={props.threadId}
          request={request}
          disabled={sending}
          targeted={props.targeted}
          onAnswer={answer}
        />
      )}
      {sending && !chosen && !failed && (
        <p role="status" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner /> Sending your answer…
        </p>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-sm text-status-failed">
          {failed}
        </p>
      )}
    </article>
  );
}

/** The pick made on this device, in place of the buttons, with a way to answer again. */
function Chosen(props: { label: string; sending: boolean; onAgain(): void }) {
  return (
    <p role="status" className="flex items-center gap-2 text-ui">
      <CheckIcon aria-hidden size={14} className="text-status-done" />
      <span>{props.label}</span>
      <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
        {props.sending ? (
          <>
            <Spinner /> sending…
          </>
        ) : (
          "· answered earlier"
        )}
      </span>
      {!props.sending && (
        <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onAgain}>
          Answer again
        </Button>
      )}
    </p>
  );
}
