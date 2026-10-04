import { Suspense, useEffect, useState, type KeyboardEvent } from "react";
import {
  useAgent,
  useInteraction,
  useIntentSender,
  useItem,
  useThreadMeta,
} from "@ace/client-react";
import type { Interaction } from "@ace/protocol";
import {
  agentName,
  displayCommand,
  offeredOptions,
  oneShotNote,
  questionTitle,
  unwrapShellCommand,
} from "@ace/ui-core";
import { CheckIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { DeferredReviewSummary } from "../items/deferred-review.ts";
import { AnsweredQuestionCard, closedMeta } from "./answered-question.tsx";
import {
  answerFailed,
  answerSending,
  answerSent,
  forgetAnswer,
  useLocalAnswer,
  type LocalAnswer,
} from "./answers.ts";
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
 * Send one answer as a durable intent. The pick shows at once (IR-2, SY-9); it is remembered
 * once the daemon accepts it, and offered again if the daemon refuses it.
 */
function useAnswerSender(interactionId: string) {
  const { send, intent, error } = useIntentSender();
  const state = intent?.state;
  useEffect(() => {
    if (state === "acked") answerSent(interactionId);
    else if (state === "failed") answerFailed(interactionId);
  }, [state, interactionId]);
  useEffect(() => {
    if (error) answerFailed(interactionId);
  }, [error, interactionId]);
  const answer: Answer = (resolution) => {
    answerSending(interactionId, resolution);
    void send({
      type: "interaction.resolve",
      interactionId: interactionId as Interaction["id"],
      resolution,
    }).catch(() => {});
  };
  const failed =
    state === "failed"
      ? (failures[intent?.error ?? ""] ??
        `The daemon rejected the answer (${intent?.error ?? "unknown"}).`)
      : error
        ? "Couldn't send the answer. Check the connection and try again."
        : undefined;
  return { answer, failed };
}

/**
 * A request from an agent, answered in place: approve or deny a command, answer questions,
 * review a plan. A question stays in the transcript once answered, as the question and the
 * answer it got; a request offered again after it was answered reads as answered (A3).
 */
export function InteractionCard(props: { threadId: string; interactionId: string }) {
  const interaction = useInteraction(props.threadId, props.interactionId);
  const agent = useAgent(props.threadId, interaction?.agentId ?? "");
  const local = useLocalAnswer(props.interactionId);
  const earlier = useEarlierAnswer(props.threadId, interaction);
  const [reopened, setReopened] = useState(false);
  const sender = useAnswerSender(props.interactionId);
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
          asker={asker}
          questions={request.questions}
          resolution={interaction.resolution ?? local?.resolution}
          meta={closedMeta(interaction, local?.state === "sent")}
        />
      );
    if (local && !reopened)
      return (
        <AnsweredQuestionCard
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
                  forgetAnswer(interaction.id);
                  setReopened(true);
                }
              : undefined
          }
        />
      );
    if (earlier && !reopened)
      return (
        <AnsweredQuestionCard
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
      threadId={props.threadId}
      interaction={interaction}
      asker={asker}
      answer={answer}
      failed={failed}
      local={reopened ? undefined : (local ?? earlierAsLocal(earlier))}
      onAnswerAgain={() => {
        forgetAnswer(interaction.id);
        setReopened(true);
      }}
    />
  );
}

function earlierAsLocal(earlier: Interaction | undefined): LocalAnswer | undefined {
  return earlier?.resolution
    ? { resolution: earlier.resolution, state: "sent", at: earlier.closedAt ?? 0 }
    : undefined;
}

function OpenRequest(props: {
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
  const title =
    request.kind === "approval"
      ? unwrappedTitle
        ? `Run ${unwrappedTitle}`
        : request.title
      : request.kind === "question"
        ? questionTitle(request.questions)
        : request.kind === "plan_review"
          ? (request.title ?? "Review the plan")
          : request.message;
  const kind = {
    approval: "Approval",
    question: "Question",
    plan_review: "Plan review",
    elicitation: request.kind === "elicitation" ? request.server : "Request",
  }[request.kind];
  const offered = request.kind === "approval" ? offeredOptions(request.options, mode) : undefined;
  const chosen =
    local?.resolution.kind === "approval" && request.kind === "approval"
      ? request.options.find(
          (option) =>
            local.resolution.kind === "approval" && option.id === local.resolution.optionId,
        )
      : undefined;
  const onKeyDown = (event: KeyboardEvent) => {
    if (!offered || sending || chosen || typing(event.target)) return;
    const digit = Number.parseInt(event.key, 10);
    const option = Number.isNaN(digit) ? undefined : offered.options[digit - 1];
    if (!option || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    answer({ kind: "approval", optionId: option.id });
  };
  return (
    <article
      aria-label={title}
      onKeyDown={onKeyDown}
      className="rounded-lg px-[18px] py-4 shadow-[inset_0_0_0_1px_var(--border)]"
    >
      <p className="flex items-center gap-[7px] text-xs text-subtle-foreground">
        <Dot tone="needs-you" />
        {props.asker} · {kind}
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
          {request.description && (
            <p className="mt-2.5 text-ui text-muted-foreground">{request.description}</p>
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
              <div className="mt-3.5 flex flex-wrap items-center gap-2">
                {offered?.options.map((option, index) => {
                  const refuse = option.kind.startsWith("deny") || option.kind === "cancel";
                  return (
                    <Button
                      key={option.id}
                      size="sm"
                      variant={refuse ? "ghost" : index === 0 ? "primary" : "secondary"}
                      aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
                      onClick={() => answer({ kind: "approval", optionId: option.id })}
                    >
                      {option.label}
                    </Button>
                  );
                })}
              </div>
              {offered && offered.hidden > 0 && mode && (
                <p className="mt-2 text-xs text-subtle-foreground">{oneShotNote(mode)}</p>
              )}
            </>
          )}
        </>
      )}
      {request.kind === "question" && (
        <QuestionForm questions={request.questions} disabled={sending} onAnswer={answer} />
      )}
      {request.kind === "plan_review" && (
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
