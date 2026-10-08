import { refusalMessage } from "@/lib/daemon-command.ts";
import { Suspense, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ClientApi } from "@ace/client";
import {
  useAgent,
  useClient,
  useInteraction,
  useIntentSender,
  useItem,
  useThreadMeta,
} from "@ace/client-react";
import type { ApprovalOption, Interaction } from "@ace/protocol";
import {
  agentName,
  approvalByKey,
  approvalCopy,
  privateBrowserGate,
  displayCommand,
  offeredOptions,
  oneShotNote,
  questionTitle,
  requestIdentity,
  unwrapShellCommand,
} from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import { ApprovalButtons, ApprovalDetails } from "@/components/approval-details.tsx";
import { PrivateBrowserNotice } from "@/components/private-browser-notice.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { DeferredReviewSummary } from "../items/deferred-review.ts";
import { AnsweredQuestionCard, closedMeta } from "./answered-question.tsx";
import { answerStore, pendingAnswers, useLocalAnswer, type LocalAnswer } from "./answers.ts";
import { QuestionForm } from "./question-form.tsx";
import { PlanReview } from "./plan-review.tsx";
import type { Answer } from "./answer.ts";
import { useEarlierAnswer } from "./use-earlier-answer.ts";

const failures: Record<string, string> = {
  already_resolved: "Already answered on another device.",
  not_found: "This request no longer exists.",
  permission_mode_requires_one_shot: "This mode allows approving one action at a time only.",
  read_only_mutation_denied: "Read only mode can't approve a change.",
};

/** Typing a digit in these goes into the field, not to an option. */
const typing = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.tagName === "TEXTAREA" ||
    (target.tagName === "INPUT" &&
      !["radio", "checkbox"].includes((target as HTMLInputElement).type)));

/**
 * Follow an answer's receipt to the end, whether or not its card is still on screen (the deck
 * drops a card as soon as its request closes, which can be before the receipt): remembered
 * once the daemon accepts it, offered again once it refuses it.
 */
function settleAnswer(
  client: ClientApi,
  commandId: string,
  interactionId: string,
  identity: string | undefined,
) {
  const receipt = client.intent(commandId);
  const settled = () => {
    const state = receipt.getSnapshot()?.state;
    if (state !== "acked" && state !== "failed") return false;
    const pick = pendingAnswers.get(interactionId);
    if (state === "acked" && pick) answerStore.remember(interactionId, pick, identity);
    pendingAnswers.clear(interactionId);
    return true;
  };
  const stop = receipt.subscribe(() => {
    if (settled()) stop();
  });
  if (settled()) stop();
}

/**
 * Send one answer as a durable intent. The pick shows at once (IR-2, SY-9); it is remembered
 * once the daemon accepts it, and offered again if the daemon refuses it.
 */
function useAnswerSender(interactionId: string, identity: string | undefined) {
  const client = useClient();
  const { send, intent, error } = useIntentSender();
  const state = intent?.state;
  const answer: Answer = (resolution) => {
    pendingAnswers.set(interactionId, resolution);
    void send({
      type: "interaction.resolve",
      interactionId: interactionId as Interaction["id"],
      resolution,
    }).then(
      (commandId) => settleAnswer(client, commandId, interactionId, identity),
      () => pendingAnswers.clear(interactionId),
    );
  };
  const failed =
    state === "failed"
      ? (failures[intent?.error ?? ""] ?? refusalMessage(intent?.error ?? "unknown"))
      : error
        ? "Couldn't send the answer. Check the connection and try again."
        : undefined;
  return { answer, failed };
}

/** How the card is drawn: a bordered card of its own, or inside a surface that frames it. */
const frames = {
  card: "rounded-lg px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)]",
  attached: "px-4 pt-3.5 pb-1",
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
}) {
  const frame = frames[props.frame ?? "card"];
  const interaction = useInteraction(props.threadId, props.interactionId);
  const agent = useAgent(props.threadId, interaction?.agentId ?? "");
  const identity = interaction ? requestIdentity(interaction) : undefined;
  const local = useLocalAnswer(props.interactionId, identity);
  const earlier = useEarlierAnswer(props.threadId, interaction);
  const [reopened, setReopened] = useState(false);
  const sender = useAnswerSender(props.interactionId, identity);
  const { failed } = sender;
  const answer: Answer = (resolution) => {
    setReopened(false);
    sender.answer(resolution);
  };
  if (!interaction) return null;
  const asker = agent ? agentName(agent) : "The agent";
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
          onAnswerAgain={() => setReopened(true)}
        />
      );
  }
  if (!pending) return null;
  return (
    <OpenRequest
      className={frame}
      attached={props.frame === "attached"}
      aside={props.aside}
      threadId={props.threadId}
      interaction={interaction}
      asker={asker}
      answer={answer}
      failed={failed}
      local={reopened ? undefined : (local ?? earlierAsLocal(earlier))}
      onAnswerAgain={() => {
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
  /** On the composer's tab: a question is sent with the composer's button, Skip is a link. */
  attached: boolean;
  aside: ReactNode;
  threadId: string;
  interaction: Interaction;
  asker: string;
  answer: Answer;
  failed: string | undefined;
  local: LocalAnswer | undefined;
  onAnswerAgain(): void;
}) {
  const { interaction, local, answer, failed } = props;
  const call = useItem(props.threadId, interaction.toolCallId ?? "");
  const mode = useThreadMeta(props.threadId)?.permission?.effective;
  const request = interaction.request;
  const sending = local?.state === "sending";
  const shell =
    call?.type === "tool_call" && call.call.detail.kind === "shell"
      ? displayCommand(call.call.detail)
      : undefined;
  const unwrappedTitle =
    request.kind === "approval" ? unwrapShellCommand(request.title)?.inner : undefined;
  const copy = request.kind === "approval" ? approvalCopy(request) : undefined;
  const title =
    request.kind === "approval"
      ? unwrappedTitle
        ? `Run ${unwrappedTitle}`
        : (copy?.title ?? request.title)
      : request.kind === "question"
        ? questionTitle(request.questions)
        : request.kind === "plan_review"
          ? (request.title ?? "Review the plan")
          : request.message;
  const kind = {
    approval: "Approval",
    question: "Question",
    plan_review: privateBrowserGate(interaction) ? "Browser" : "Plan review",
    elicitation: request.kind === "elicitation" ? request.server : "Request",
  }[request.kind];
  const offered = request.kind === "approval" ? offeredOptions(request.options, mode) : undefined;
  // The request's own order and words. A one-shot mode leaves out session and always grants,
  // except on ace's own tools, which ace answers before that rule.
  const choices = copy?.tool
    ? copy.choices
    : copy?.choices.filter((choice) =>
        offered?.options.some((option) => option.id === choice.option.id),
      );
  const chosen =
    local?.resolution.kind === "approval" && request.kind === "approval"
      ? request.options.find(
          (option) =>
            local.resolution.kind === "approval" && option.id === local.resolution.optionId,
        )
      : undefined;
  const [nudged, setNudged] = useState<ApprovalOption>();
  const onKeyDown = (event: KeyboardEvent) => {
    if (!offered || sending || chosen || typing(event.target)) return;
    const digit = Number.parseInt(event.key, 10);
    const option = Number.isNaN(digit) ? undefined : choices?.[digit - 1]?.option;
    if (!option || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    // A default-to-no request is approved only by a click (or Enter on its focused button).
    if (request.kind === "approval" && !approvalByKey(request, option)) return setNudged(option);
    answer({ kind: "approval", optionId: option.id });
  };
  return (
    <article aria-label={title} onKeyDown={onKeyDown} className={props.className}>
      <p className="flex min-h-6 items-center gap-[7px] text-xs text-subtle-foreground">
        <Dot tone="needs-you" />
        {props.asker} · {kind}
        <span className="ml-auto flex items-center gap-3">
          {props.aside}
          {props.attached && request.kind === "question" && (
            <button
              type="button"
              disabled={sending}
              onClick={() => answer({ kind: "question", answers: {}, dismissed: true })}
              className="rounded-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-ring disabled:opacity-50"
            >
              Skip
            </button>
          )}
        </span>
      </p>
      {request.kind !== "question" || request.questions.length !== 1 ? (
        <h3 className="mt-2 mb-2.5 text-md leading-[1.35] font-medium tracking-[-0.005em]">
          {title}
        </h3>
      ) : null}
      {shell && (
        <pre className="rounded-md bg-code px-3 py-[9px] font-mono text-[12.5px] leading-[1.5] whitespace-pre-wrap">
          {shell.command}
        </pre>
      )}
      {request.kind === "approval" && (
        <>
          {copy?.tool ? (
            <ApprovalDetails copy={copy} className="mt-2.5" />
          ) : (
            request.description && (
              <p className="mt-2.5 text-ui text-muted-foreground">{request.description}</p>
            )
          )}
          {interaction.review && (
            <Suspense fallback={null}>
              <DeferredReviewSummary.Component review={interaction.review} className="mt-2.5" />
            </Suspense>
          )}
          {chosen ? (
            <p role="status" className="mt-3.5 flex items-center gap-2 text-ui">
              <CheckIcon aria-hidden size={14} className="text-status-done" />
              <span>{chosen.label}</span>
              <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
                {sending ? (
                  <>
                    <Spinner /> sending…
                  </>
                ) : (
                  "· answered earlier"
                )}
              </span>
              {!sending && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={props.onAnswerAgain}>
                  Answer again
                </Button>
              )}
            </p>
          ) : (
            <>
              <div className="mt-3.5">
                <ApprovalButtons
                  choices={choices ?? []}
                  numbered
                  keyed={(choice) => approvalByKey(request, choice.option)}
                  onChoose={(choice) => answer({ kind: "approval", optionId: choice.option.id })}
                />
              </div>
              {nudged && (
                <p role="status" className="mt-2 text-xs text-subtle-foreground">
                  This request defaults to no: click {nudged.label} to allow it.
                </p>
              )}
              {!copy?.tool && offered && offered.hidden > 0 && mode && (
                <p className="mt-2 text-xs text-subtle-foreground">{oneShotNote(mode)}</p>
              )}
            </>
          )}
        </>
      )}
      {request.kind === "question" && (
        <QuestionForm
          questions={request.questions}
          disabled={sending}
          onAnswer={answer}
          composer={props.attached ? props.threadId : undefined}
        />
      )}
      {request.kind === "plan_review" && privateBrowserGate(interaction) && (
        <PrivateBrowserNotice />
      )}
      {request.kind === "plan_review" && !privateBrowserGate(interaction) && (
        <PlanReview disabled={sending} onAnswer={answer}>
          <Prose text={request.markdown} className="text-ui leading-[1.55]" />
        </PlanReview>
      )}
      {request.kind === "elicitation" && (
        <div className="mt-3.5 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={sending}
            onClick={() => answer({ kind: "elicitation", action: "accept" })}
          >
            Continue
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={sending}
            onClick={() => answer({ kind: "elicitation", action: "decline" })}
          >
            Decline
          </Button>
        </div>
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
